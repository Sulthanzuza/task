# Deploying Team Task Manager

Written for whoever runs this on a server, including the version of you that
has forgotten how it works.

> This is the **Docker deployment** on a VM of your own. For the free,
> no-credit-card deployment on Render and Supabase, see
> [`deploy-render.md`](deploy-render.md).

The target is **Oracle Cloud Always Free**: one Ampere A1 VM (arm64, Ubuntu
24.04, 2 OCPU / 6 GB) in Mumbai or Hyderabad, which is enough for a team of
eight to thirty. Around it:

| What | Where | Free tier |
| --- | --- | --- |
| The app: nginx, API, worker, Postgres, backup job, watchdog | the VM, from `docker-compose.prod.yml` | Always Free A1 |
| Task attachments | OCI Object Storage, through its S3 API | 20 GB, 50,000 requests a month |
| Email | Brevo SMTP relay, port 587 | 300 emails a day |
| Off-site backups | Backblaze B2, through its S3 API | 10 GB |
| Uptime monitoring | UptimeRobot | 50 monitors, 5-minute checks |

Placeholders used throughout: `tasks.example.com` is your app's domain,
`example.com` the domain you send mail from, `<SERVER_IP>` the VM's public IP.
**The whole sequence**, at the end, lists every command in order.

---

## Oracle Cloud: the server

Done once, in the Oracle console and then on the VM. Everything after this
section is the same on any Ubuntu 24.04 server.

### Everything runs on arm64

The A1 shape is Ampere ARM, so every image must have a `linux/arm64` build.
They do:

| Image | arm64 |
| --- | --- |
| `api`, `worker`, `migrate` (`docker/api.Dockerfile`, on `node:22-alpine`) | built on the server, natively |
| `web` (`docker/web.Dockerfile`, on `nginx:1.27-alpine`) | built on the server, natively |
| `backup` (`docker/backup.Dockerfile`, on `postgres:16-alpine`, rclone from the Alpine archive) | built on the server, natively |
| `postgres:16-alpine`, `certbot/certbot`, `willfarrell/autoheal` | published for `linux/arm64` |

The one native module, **argon2**, ships prebuilt binaries for
`linux-arm64` on both glibc and musl, so nothing is compiled during
`pnpm install`.

There is no MinIO any more. Its server image and its `mc` client stopped being
published in 2025 (Docker Hub returns 404, `dl.min.io` returns 410), so a
fresh server could neither start the old stack nor build the backup image.
Attachments moved to OCI Object Storage, and the backup scripts use rclone.

To prove an arm64 build from an x86 machine before the server exists (Docker
Desktop emulates arm64, so it is slow but faithful):

```bash
docker buildx build --platform linux/arm64 -f docker/api.Dockerfile    -t tm-api:arm64    --load .
docker buildx build --platform linux/arm64 -f docker/web.Dockerfile    -t tm-web:arm64    --load .
docker buildx build --platform linux/arm64 -f docker/backup.Dockerfile -t tm-backup:arm64 --load .

# argon2 really loads and hashes on arm64:
docker run --rm --platform linux/arm64 --entrypoint sh tm-api:arm64 -c \
  'uname -m; node --input-type=module -e "import a from \"argon2\"; console.log(await a.verify(await a.hash(\"x\"), \"x\"))"'
# aarch64
# true
```

`.dockerignore` keeps the host's `node_modules` out of the build context. A
Windows or macOS checkout's links and native binaries copied into a Linux
image are what break a build made on a laptop.

### 1. Create the instance

**Compute → Instances → Create instance**:

- **Name:** `taskmanager`.
- **Image:** Canonical Ubuntu 24.04 (the full image, not "Minimal"). With an
  Ampere shape selected, the console picks the aarch64 build.
- **Shape:** Ampere → `VM.Standard.A1.Flex`, **2 OCPU, 6 GB** memory. It
  should say "Always Free-eligible".
- **Networking:** create a new VCN with a public subnet, and tick **Assign a
  public IPv4 address**.
- **SSH keys:** **Upload public key files** and choose your public key
  (`~/.ssh/id_ed25519.pub`; on Windows,
  `C:\Users\<you>\.ssh\id_ed25519.pub`). Never the private one.
- **Boot volume:** the default 50 GB is fine and within the free 200 GB.

"Out of capacity" for A1 is common in the Indian regions. It is not your
configuration: try again later, or in another availability domain if the
region shows one.

When it is running, note the **public IP** on the instance page and sign in:

```bash
ssh ubuntu@<SERVER_IP>
```

The public IP stays through reboots and stop/start. It is released only if
the instance is terminated.

### 2. Open 80 and 443 in the VCN security list

Oracle filters traffic twice: once in the network (the security list) and
again on the VM (iptables, next step). Both must allow a port.

**Networking → Virtual cloud networks → (your VCN) → Security → Default
Security List → Add Ingress Rules**, twice:

| Source CIDR | IP protocol | Destination port |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

Leave **Stateless** unticked. Port 22 is already there. Nothing else gets a
rule: Postgres and the API are not published, and must stay that way.

### 3. Open 80 and 443 on the VM: iptables, not ufw

Oracle's Ubuntu images ship their own iptables rules in
`/etc/iptables/rules.v4`, loaded at boot by `netfilter-persistent`. The
`INPUT` chain allows SSH and ends with
`REJECT --reject-with icmp-host-prohibited`, and `FORWARD` ends with the same
REJECT.

**Use iptables alone. Do not enable ufw.** ufw would write a second set of
rules over Oracle's, and Oracle's documentation warns that editing these rules
with ufw can stop the instance from booting. The rules also carry the
`InstanceServices` chain the VM needs to reach Oracle's metadata service and
its boot volume.

**Do this before installing Docker**, for the reason in the paragraph after
the commands.

```bash
# The REJECT is the last INPUT rule; insert the two ACCEPTs just above it.
sudo iptables -L INPUT -n --line-numbers
N=$(sudo iptables -L INPUT -n --line-numbers | awk '$2 == "REJECT" { print $1; exit }')
echo "$N"                     # e.g. 6; must not be empty
sudo iptables -I INPUT "$N" -p tcp -m state --state NEW --dport 443 -j ACCEPT
sudo iptables -I INPUT "$N" -p tcp -m state --state NEW --dport 80  -j ACCEPT
sudo iptables -L INPUT -n --line-numbers    # 80 and 443 now come before REJECT

# Write them into /etc/iptables/rules.v4, so they come back after a reboot.
sudo netfilter-persistent save
grep -E 'dport (80|443)' /etc/iptables/rules.v4
```

**Never run `netfilter-persistent save` again once Docker is running.** It
would write Docker's own chains into `rules.v4`. They would then be loaded at
boot before Docker starts and creates them again, leaving duplicate and stale
rules. To change the host's rules later, edit `/etc/iptables/rules.v4` by
hand, and apply the same change live with `iptables -I`.

Strictly, these two rules are not what lets nginx answer. Docker publishes
nginx's ports with a DNAT rule, so that traffic goes through `FORWARD`, where
Docker inserts its own ACCEPT rules above Oracle's REJECT, rather than through
`INPUT`. The INPUT rules are for anything that listens on the host itself, and
they make the host's rules say what the security list says.

> **Docker bypasses the host firewall for published ports.** Publishing a
> port writes DNAT and FORWARD rules that are consulted before anything in
> `INPUT`. A container published as `5432:5432` is reachable from anywhere
> the security list allows, whatever the host rules say. The only reliable
> defence is not to publish the port. Bind it to `127.0.0.1:5432:5432` if you
> ever need it locally, never to `0.0.0.0`.
>
> In this deployment **only nginx may publish a port**, and it publishes 80
> and 443. Postgres, the API and the worker talk to each other over the
> Compose network and are not reachable from outside the host. If you add a
> service, do not give it a `ports:` entry. The security list, which allows
> only 22, 80 and 443, is the second line of defence.

### 4. Don't let Oracle reclaim it as idle

Oracle reclaims an Always Free instance it considers idle. On A1 shapes that
means that over **seven days, all three** of these stay under 20%: CPU
utilisation (95th percentile), network utilisation, and memory utilisation.

For a team this size, CPU and network will sit far below 20% almost all the
time. **Memory is the one that decides**, so it is the one to check.

The day after the stack is up and people have used it:

```bash
free -m
# Memory in use, not counting cache the kernel can give back:
free -m | awk '/^Mem:/ { printf "%.0f%% of %d MB in use\n", ($2 - $7) * 100 / $2, $2 }'
```

Oracle's own figure is in the console under **Instance → Monitoring → Memory
Utilization**. If the two disagree, Oracle's is the one that counts.

If it is **under 20%**, shrink the VM's memory so that what the stack uses is
a larger share of it. Aim for about 25%, not just over 20%. For example, if
1.0 GB is in use, 4 GB gives 25%.

**Instance → Edit → Edit shape** → keep 2 OCPU, set memory to the new figure →
**Save changes**. The instance reboots: do it outside working hours, take a
backup first (see **Backups**), and run the smoke test afterwards. The 2 GB
swap file set up below covers the occasional spike.

Check `free -m` again a week later, since usage grows as the database does.

### 5. A bucket for attachments: OCI Object Storage

The API stores attachments through the S3 API, and Oracle's Object Storage
offers one.

1. **Find the namespace.** Profile menu → **Tenancy: <name>** → **Object
   storage namespace**, a short random string. On the same page, under
   **Object storage settings**, note the **Amazon S3 Compatibility API
   designated compartment**, which is the root compartment unless you changed
   it. The bucket must be in that compartment, or the S3 API cannot see it.
2. **Create the bucket.** **Storage → Buckets** → that compartment → **Create
   Bucket**: name `task-attachments`, default storage tier Standard. It is
   private by default; keep it so. The API serves every file itself, after
   checking permissions.
3. **A user that can reach this bucket and nothing else.** A key made for
   your own administrator account would open everything in the tenancy.
   **Identity & Security → Domains → Default domain**:
   - **Users → Create user**: `taskmanager-storage`, any email you control.
   - **Groups → Create group**: `taskmanager-storage`, and add the user.
   - **Identity & Security → Policies** (root compartment) **→ Create
     Policy**, `taskmanager-storage`, in the manual editor:

     ```
     Allow group 'Default'/'taskmanager-storage' to read buckets in tenancy where target.bucket.name = 'task-attachments'
     Allow group 'Default'/'taskmanager-storage' to manage objects in tenancy where target.bucket.name = 'task-attachments'
     ```
4. **Its key.** Open the user → **Customer secret keys → Generate secret
   key**, named `taskmanager`. **Copy the secret now**, because it is shown
   once. The **Access key** is the long ID in the list afterwards.

These go into `.env.production` (region `ap-mumbai-1` or `ap-hyderabad-1`,
matching the VM):

```
S3_ENDPOINT=https://<namespace>.compat.objectstorage.ap-mumbai-1.oraclecloud.com
S3_REGION=ap-mumbai-1
S3_BUCKET=task-attachments
S3_ACCESS_KEY_ID=<access key>
S3_SECRET_ACCESS_KEY=<secret key>
S3_FORCE_PATH_STYLE=true
```

The Always Free allowance is 20 GB and 50,000 requests a month. Every upload
and download is a request, and so is each object the nightly backup checks.
That is plenty for a team of thirty. If the console ever shows the count
approaching the limit, the backup's copy of this bucket is the first thing
to make less frequent.

---

## Before you start

The Oracle VM from the section above, signed in as `ubuntu`.

**1. A user that is not root, and not `ubuntu`.** Everything below is run as
this user.

```bash
sudo adduser deploy                      # sets a password: sudo will ask for it
sudo usermod -aG sudo deploy
sudo rsync --archive --chown=deploy:deploy /home/ubuntu/.ssh /home/deploy
```

From your own machine, `ssh deploy@<SERVER_IP>` must now work. Then, in
`/etc/ssh/sshd_config`, set `PermitRootLogin no` and
`PasswordAuthentication no` (Oracle's image already sets the second, in
`/etc/ssh/sshd_config.d/`), and run `sudo systemctl restart ssh`. Keep your
current session open while you test the new login from another terminal: a
typo here locks you out of the server.

**2. Docker Engine and the Compose plugin**, after the iptables step above.
Not `docker.io` from the Ubuntu archive, which is older than the Compose file
expects. The convenience script installs the arm64 build by itself.

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy && newgrp docker
docker compose version                       # v2.x
docker info --format '{{.Architecture}}'     # aarch64
```

**3. Swap, so a build does not kill the box.** 6 GB runs the stack easily,
but building three images next to a running Postgres, or memory shrunk for
the idle rule above, is when the kernel's OOM killer picks a victim, and it is
usually Postgres.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h                                 # Swap: 2.0Gi
```

**4. Security updates, applied on their own.**

```bash
sudo apt update && sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades    # answer Yes
systemctl status unattended-upgrades --no-pager | head -3
```

This takes security patches only, and does not reboot by itself. Kernel
updates still need a reboot you schedule; `/var/run/reboot-required` exists
when one is waiting.

**5. DNS pointing here, before certbot runs.** An `A` record for
`tasks.example.com` with the value `<SERVER_IP>`. Let's Encrypt resolves the
name itself, so a record that has not propagated is a failed issuance and a
rate limit you then wait out.

```bash
dig +short tasks.example.com          # must print this server's public IP
curl -fsS https://ifconfig.me && echo  # which is this
```

**6. The code.**

```bash
sudo mkdir -p /srv/taskmanager && sudo chown deploy:deploy /srv/taskmanager
git clone <repo> /srv/taskmanager
cd /srv/taskmanager
git checkout v1.0.0-rc4
```

**7. Brevo and Backblaze B2, set up.** See **Email: Brevo** and **Backups:
Backblaze B2** below. Their values go into `.env.production` in the next
step. Without SPF and DKIM, invitations and alerts land in spam and the
product looks broken on day one.

---

## First deploy

### 1. Configuration

```bash
cd /srv/taskmanager
cp .env.production.example .env.production
```

Every value the API will not start without, and how to make it:

| Variable | How to produce it | What rejects it |
| --- | --- | --- |
| `SERVER_NAME` | your domain, e.g. `tasks.example.com` | nginx cannot find its certificate without it; Compose refuses to start |
| `WEB_ORIGIN` | `https://` + the same domain | must be `https` in production |
| `DATABASE_URL` | `postgres://USER:PASSWORD@postgres:5432/DB`, matching the three `POSTGRES_*` values | must parse as a URL |
| `DATABASE_TLS` | `off`: Postgres is on the Compose network, so there is no certificate to verify | unset means `verify`, and production then refuses to start without `DATABASE_CA_CERT` |
| `POSTGRES_USER` | anything, e.g. `taskmanager` | — |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | — |
| `POSTGRES_DB` | anything, e.g. `taskmanager` | — |
| `JWT_ACCESS_SECRET` | `openssl rand -hex 32` | under 32 characters, or left as the development default |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | OCI Object Storage: see **Oracle Cloud: the server**, step 5 | — |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | the Customer Secret Key of `taskmanager-storage` | — |
| `STORAGE_DRIVER` | `s3` | `local` is refused: it keeps uploads on one container's disk |
| `MAIL_TRANSPORT` | `smtp` | unset is refused in production |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | `smtp-relay.brevo.com`, `587`, `false` (STARTTLS) | — |
| `SMTP_USER` / `SMTP_PASS` | Brevo's SMTP login and an SMTP key: see **Email: Brevo** | — |
| `MAIL_FROM` | `Task Manager <no-reply@example.com>`, at the domain authenticated in Brevo | — |
| `MAIL_ENABLED` | `true` | `false` is refused in production |
| `JOB_QUEUE_ENABLED` | `true` | `false` is refused in production |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION` | `https://s3.<region>.backblazeb2.com` and `<region>`: see **Backups: Backblaze B2** | the backup job will not run without it |
| `BACKUP_S3_BUCKET` | the B2 bucket | as above |
| `BACKUP_S3_ACCESS_KEY` / `BACKUP_S3_SECRET_KEY` | the B2 application key's `keyID` / `applicationKey` | as above |
| `WORKER_HEALTH_PORT` | `4001` | unset means the worker serves no health endpoint and the watchdog cannot see it |
| `NODE_ENV` | `production` | anything else turns the production checks off |

The rest have working defaults, including the two `AWS_*_CHECKSUM_*`
settings: the AWS SDK's default checksums are not accepted by every
S3-compatible store, so the example sends them only where S3 requires one.
`CORS_ORIGINS` stays empty: the app and the
API are the same origin, so there is no cross-origin request to allow.

Check it before starting anything. There is no Node and no pnpm on this
server and there is no reason to install them: the check ships inside the API
image and runs the same Zod schema and the same production rules the API
applies at boot.

```bash
docker compose -f docker-compose.prod.yml build api
docker compose -f docker-compose.prod.yml run --rm --no-deps api \
  node dist/cli/envCheck.js
```

`--no-deps` because this must not start Postgres to tell you a secret is too
short. It prints every problem at once and exits non-zero, so it also works
as a gate in a deploy script.

### 2. Start

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
```

The `migrate` service runs to completion before the API starts, so the schema
is always applied before anything serves. On this first boot nginx writes
itself a self-signed placeholder certificate so it can start at all; the next
step replaces it.

### 3. TLS, before anybody signs in

Webroot mode: nginx keeps running and serves the challenge out of a shared
volume. The alternative, `--standalone`, wants port 80 to itself, which means
taking the site down to issue and again to renew.

On this first boot nginx is serving a **self-signed placeholder**, written to
`/etc/nginx/placeholder/` inside the container. It has to serve something, or
it will not start, and then it cannot answer the challenge that would get it
a real certificate. The placeholder deliberately does **not** live in
`/etc/letsencrypt/live/<domain>/`: that directory belongs to certbot, and
certbot finding it already populated would quietly issue to
`<domain>-0001` instead and leave nginx serving the self-signed one forever.
nginx reads `/etc/nginx/tls`, a symlink, which is what moves.

```bash
docker compose -f docker-compose.prod.yml run --rm certbot certonly \
  --webroot --webroot-path /var/www/certbot \
  -d tasks.example.com \
  --email you@example.com --agree-tos --no-eff-email

# Point the symlink at the real certificate and reload. Without this you
# wait up to six hours for the watcher to do it.
docker compose -f docker-compose.prod.yml exec web /usr/local/bin/use-real-cert
```

Now prove it, rather than trusting it. The failure mode here is silent: the
site is up, and only a browser tells you the certificate is wrong.

```bash
./scripts/check-tls.sh tasks.example.com
```

That checks three things: that `certs/live/tasks.example.com/` exists with no
`-0001` sibling, that the certificate actually on the wire is issued by
Let's Encrypt rather than being self-signed, and that HTTP redirects to
HTTPS. By hand, the same question:

```bash
echo | openssl s_client -servername tasks.example.com \
  -connect tasks.example.com:443 2>/dev/null | openssl x509 -noout -issuer -dates
# issuer=C=US, O=Let's Encrypt, CN=...     <- not "CN=tasks.example.com"
ls certs/live/                              # exactly one directory
```

**What renews it.** The `certbot` service runs
`certbot renew --webroot` in a loop with `sleep 12h`, so twice a day; `renew`
does nothing until a certificate is inside thirty days of expiry. Its
`--deploy-hook` writes `certs/last-renewal`, which is how you tell a renewal
happened. nginx picks the new file up because the web container runs
`use-real-cert` every six hours
(`docker/entrypoint.d/20-watch-for-renewals.sh`), re-pointing the symlink and
reloading. The reload is done from inside the web container on purpose:
doing it from certbot would mean giving the container that talks to the
public internet access to the Docker socket.

Test the renewal path now, not in ninety days:

```bash
docker compose -f docker-compose.prod.yml run --rm certbot renew --dry-run
docker compose -f docker-compose.prod.yml logs --tail=20 certbot
```

### 4. The first administrator

The CLI sets the password itself: it prompts for one and writes the hash. It
sends **no email** and there is no set-password link to wait for, so the
administrator comes first and the test email after: it is sent from the
administrator's settings, in step 6. Had the CLI emailed a link, the order
would have to be the other way round.

Everyone *else* is invited from the UI, and an invitation is an email, so
mail has to work before you invite anybody — including the smoke account in
step 6.

```bash
docker compose -f docker-compose.prod.yml run --rm api \
  node dist/cli/createUser.js --email you@example.com --name "Your Name" --role SUPER_ADMIN
```

Omit `--password` and it prompts, which keeps it out of your shell history.
It must be at least 10 characters with an upper case letter, a lower case
letter and a digit.

There is deliberately no unauthenticated "create the first admin" page: that
is a race with whoever finds the deployment first.

### 5. Organisation settings and holidays

Do this before anybody is invited. Every business date in the product —
overdue, due today, working days, the digest hour, the heat map — is computed
from these, and changing them later silently moves dates on work that already
exists.

Signed in as the administrator. "Settings" is the **More** menu (the gear) in
the top bar.

**Settings → Organisation**

- Time zone: `Asia/Kolkata`
- Weekend days: Saturday and Sunday
- Working hours per day: `8`
- Daily digest at: `09:00`
- Week starts on: Monday

**Settings → Holidays**

Add this year's public holidays. A task is not overdue because of a day
nobody was working, and the alerts, the digest and the due-load heat map all
count working days against this list. Add next year's in December.

### 6. Email, before the first invitation

**Settings → Email → Send a test email**, to an address at a different
provider from your own. Then open the message and read its headers: both SPF
and DKIM must say `pass`. Mail that fails either lands in spam, and the first
thing anybody experiences of this product is an invitation that never
arrived.

Fix SPF and DKIM at your DNS provider before going on (see **Email: Brevo**).
If Brevo refuses the login outright, its SMTP relay may not be activated yet on
a new account: Brevo's support enables it on request.

### 7. The smoke team

The smoke test writes: it creates a task, moves it and deletes it, because a
read-only check cannot tell a working deployment from one whose database is
mounted read-only. That traffic needs somewhere to go that is not a real
team's board.

In **Settings → Teams**, create a team called `Smoke` with **Internal team**
ticked. An internal team is an ordinary team for every permission question
and is left out of the dashboard pickers, the daily digest and the overdue
alerts, so the pipeline cannot move the numbers a lead reads or page anybody
about a task that existed for ninety seconds.

Then:

1. **Settings → Projects**: a project called `Smoke`, key `SMOKE`, in that team.
2. **Settings → People**: invite `smoke@yourdomain`, role Team Lead, and make
   it the lead of the Smoke team so it can create and delete there.
3. Set its password from the invitation email and keep it in your secret
   store. It is not a real person's login and must not be an administrator.

### 8. Prove the backups

See **Backups** below, and do the restore drill now rather than later.

---

### Seeds do not run here

There is no seed step in a production deploy, and the scripts enforce it
rather than relying on nobody typing them. `pnpm db:seed` and
`pnpm db:seed --demo` both refuse to run when `NODE_ENV=production`: the demo
seed would add roughly two hundred invented tasks to a real team's board, and
there is no undo for that beyond a restore.

The only thing that writes to a fresh production database is the `migrate`
service, and then the one administrator you create by hand above.

### Fonts are served from here

The interface is set in Plus Jakarta Sans, and the file is in the image
(`apps/web/public/fonts`, served at `/fonts/`). Nothing is fetched from Google
at runtime, so the application needs no outbound network access to render, and
no `font-src` or `style-src` allowance for a third party.

The file name has no content hash in it, so Nginx caches `/fonts/` for thirty
days rather than the year it gives `/assets/`: long enough that nobody
refetches it, short enough that replacing the file reaches people without a
rename.

## Email: Brevo

Mail goes through Brevo's SMTP relay on port 587 with STARTTLS. The free plan
sends 300 emails a day, which a team of thirty does not approach: emails are
collapsed to one per burst, and the digest is one a day per person. Oracle
blocks outbound port 25, and 587 is open.

**1. The SMTP credentials.** In Brevo, **SMTP & API → SMTP**:

- **SMTP server** `smtp-relay.brevo.com`, **port** `587`.
- **Login**: looks like `1a2b3c001@smtp-brevo.com`. This is `SMTP_USER`. It is
  not your Brevo account email.
- **Generate a new SMTP key**: this is `SMTP_PASS`. An SMTP key, not an API
  key; the two are not interchangeable.

```
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false        # STARTTLS: starts plain, upgraded before login
SMTP_USER=<brevo smtp login>
SMTP_PASS=<brevo smtp key>
MAIL_FROM="Task Manager <no-reply@example.com>"
```

`SMTP_SECURE=true` would be TLS from the first byte, which is port 465. On
587 it fails the handshake.

**2. Authenticate the sending domain.** **Senders, Domains & Dedicated IPs →
Domains → Add a domain**: the domain in `MAIL_FROM` (`example.com` here, not
necessarily the app's `tasks.` subdomain). Brevo then lists the exact records
to create. Copy its values, since the codes and the DKIM targets are specific
to your account. They have this shape:

```
; Proves to Brevo you own the domain
example.com.                    TXT    "brevo-code:<code from Brevo>"

; DKIM: Brevo signs every message; these let receivers check the signature
brevo1._domainkey.example.com.  CNAME  b1.example-com.dkim.brevo.com.
brevo2._domainkey.example.com.  CNAME  b2.example-com.dkim.brevo.com.

; SPF: Brevo may send as this domain
example.com.                    TXT    "v=spf1 include:spf.brevo.com ~all"

; DMARC: what receivers do with mail that fails both
_dmarc.example.com.             TXT    "v=DMARC1; p=none; rua=mailto:postmaster@example.com"
```

- **One SPF record per name.** If `example.com` already has one (Google
  Workspace, Microsoft 365), add `include:spf.brevo.com` to it rather than
  creating a second. Two SPF records is a permanent SPF error, which is worse
  than none.
- **DKIM is what carries DMARC here.** Brevo sends from its own bounce domain,
  so SPF passes for Brevo's domain, not yours. DMARC alignment comes from the
  DKIM signature, which is why the two DKIM records are not optional.
- Start DMARC at `p=none`, and move to `p=quarantine` once a few weeks of
  reports show only Brevo sending as you.

Then click **Authenticate this email domain** in Brevo. It checks the records
itself, and DNS can take an hour.

**3. Prove it.** After the administrator exists: **Settings → Email → Send a
test email**, to an address at a different provider from your own. Open the
received message's headers (Gmail: ⋮ → **Show original**) and check
`spf=pass`, `dkim=pass` and `dmarc=pass`. Do this before inviting anybody.

---

## Health and restarts

| Service | Check | What it means |
| --- | --- | --- |
| `api` | `GET /api/v1/ready` | Database **and** job queue reachable |
| `api` | `GET /api/v1/health` | Process alive, database reachable |
| `worker` | `GET :$WORKER_HEALTH_PORT/health` | Worker process alive (4001 in the compose file) |
| `web` | `GET /healthz` | Nginx serving |
| `postgres` | `pg_isready` | Accepting connections |

The worker's port comes from `WORKER_HEALTH_PORT`. It is set in
`docker-compose.prod.yml` and in `.env.production.example`; the worker serves
no health endpoint at all if it is unset, and the watchdog then has nothing to
check.

`restart: unless-stopped` only restarts a container that **exits**. A container
that is running but failing its health check would otherwise sit there
indefinitely, which is precisely what a health check exists to catch, so the
`autoheal` service watches for it and restarts anything labelled
`autoheal: 'true'`.

---

## Scaling out: read this first

**Run exactly one API instance.** Socket.IO holds connection state in memory,
so with two instances a client connected to A never hears an event emitted on
B. The board stops updating for some people and not others, which is worse than
it not updating at all, because nobody reports it.

Before adding a second instance, do one of:

- **Socket.IO Postgres adapter** — `@socket.io/postgres-adapter`, pointed at the
  same database. Events are broadcast through Postgres, so any instance can
  serve any client. This is the option that suits this stack.
- **Sticky sessions** — `ip_hash` in the Nginx upstream, so a client always
  reaches the same instance. Simpler, but a restart drops those clients and it
  does nothing for events raised by the worker.

The worker is different: **several workers are safe today.** Alerts claim
through `alert_log` and digests through `digest_log`, both with
`ON CONFLICT DO NOTHING` in the same transaction as the notifications they
guard, so no job can act twice.

---

## Backups

The copy that counts is the one that is not on this server. A backup beside
the database survives a disk failure and nothing else: not a deleted provider
account, not ransomware, which reaches a local folder first, and not somebody
running the wrong `docker compose down -v`.

So the nightly job does three things: dumps the database, copies the dump to
a **different provider**, and mirrors the attachments bucket there too. A
restore with every file on every task broken is a restore that fails review.

The job runs once when the container starts and then every 24 hours
(`BACKUP_INTERVAL_SECONDS`). It uses rclone, configured entirely from the
`BACKUP_S3_*` and `S3_*` variables (`scripts/rclone-remotes.sh`), so no file
on the server holds the keys.

### Backblaze B2

Off-site means a different provider from Oracle. Losing the Oracle account,
which on the free tier can happen without much warning, must not take the
backups with it.

1. **Create a bucket.** **Buckets → Create a Bucket**: a globally unique name
   such as `<yourcompany>-taskmanager-backup`, **Private**, default encryption
   on. The bucket page then shows **Endpoint:
   `s3.<region>.backblazeb2.com`**. The middle part, e.g. `us-west-004` or
   `eu-central-003`, is the region.
2. **Lifecycle: "Keep only the last version of the file".** Bucket →
   **Lifecycle Settings**. This matters: through the S3 API, B2 does not
   delete a file, it *hides* it. Under the default "keep all versions", every
   dump the script removes after 14 days would stay, and be billed, for ever.
   With this setting a hidden file is gone a day later.
3. **An application key for this bucket only.** **Application Keys → Add a New
   Application Key**: **Allow access to Bucket(s)** → this bucket, **Type of
   Access** → Read and Write. Copy `keyID` and `applicationKey` when shown;
   the second is shown once. A key taken from this server then reaches one
   bucket and nothing else in the account.

```
BACKUP_S3_ENDPOINT=https://s3.<region>.backblazeb2.com
BACKUP_S3_REGION=<region>
BACKUP_S3_BUCKET=<yourcompany>-taskmanager-backup
BACKUP_S3_ACCESS_KEY=<keyID>
BACKUP_S3_SECRET_KEY=<applicationKey>
BACKUP_RETENTION_DAYS=14
```

**Retention: 14 days off-site, 3 days locally.** The script deletes off-site
dumps older than `BACKUP_RETENTION_DAYS`, and the lifecycle rule above turns
those deletions into freed space. The local copies are a convenience for a
fast restore rather than the backup. Attachments are copied, never synced,
so a file deleted in the app stays in the backup.

At this size a dump is a few megabytes, and B2's free 10 GB covers 14 days of
them many times over. The attachments copy is what grows.

```bash
# On demand, rather than waiting for the nightly run
docker compose -f docker-compose.prod.yml exec backup /scripts/backup.sh

# What is off-site. Single quotes and sh -c, so $BACKUP_S3_BUCKET is
# expanded inside the container where it has a value: your shell would
# expand it to nothing and you would list the wrong path and see nothing,
# which looks exactly like a backup that is not running.
docker compose -f docker-compose.prod.yml exec backup \
  sh -c '. /scripts/rclone-remotes.sh && rclone lsl "backup:$BACKUP_S3_BUCKET/database"'
```

### Restoring

The drill restores from the **remote** copy, not from the folder on this
server. Restoring the file still sitting here proves the dump is readable and
nothing whatever about whether the backup that matters actually arrived.

The database password must not go on the command line: it would be in your
shell history, in `ps` output while the command runs, and in the Compose
logs. The container already has it, so build the URL in there.

```bash
# 1. A scratch database to restore into.
docker compose -f docker-compose.prod.yml exec postgres \
  sh -c 'createdb -U "$POSTGRES_USER" taskmanager_restore'

# 2. Restore the newest off-site dump into it. The URL is assembled inside
#    the container from variables it already holds, so nothing secret is
#    typed. The script refuses any target not ending _restore, _scratch or
#    _verify, so it cannot be pointed at the live database by a typo.
docker compose -f docker-compose.prod.yml exec backup sh -c \
  '/scripts/restore.sh remote "postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/taskmanager_restore"'

# 3. Drop it. A second copy of everybody's data, sitting on the same server
#    with nobody looking after it, is not something to leave behind.
docker compose -f docker-compose.prod.yml exec postgres \
  sh -c 'dropdb -U "$POSTGRES_USER" taskmanager_restore'
```

Step 2 prints how many users and tasks came back and fails if the answer is
none. Do this on the day you deploy, and then once a quarter.

### Restore drill log

**A backup nobody has restored is a hope, not a backup.** Do this monthly and
add a line here.

| Date | Dump | Result | By |
| --- | --- | --- | --- |
| 2026-09-29 | `taskmanager-20260929T104132Z.dump` (80,444 bytes) | Restored into `taskmanager_restore`: **7 users, 21 tasks**, verification passed | Initial verification before first use |

The refusal guard was checked at the same time: restoring into `taskmanager`
was rejected with *"Refusing to restore into 'taskmanager': name it *_restore,
*_scratch or *_verify"*.

---

## Before the first real user signs in

- [ ] Nightly backup has run at least once, and the dump is in the off-site bucket.
- [ ] A restore **from the off-site copy** into a scratch database has
      succeeded, and the scratch database has been dropped.
- [ ] An attachment uploaded in the app downloads again (OCI Object Storage
      works), and appears under `files/` in the B2 bucket after the next backup.
- [ ] A test email has actually arrived. **Settings → Email → Send a test
      email**, to an address on a different provider from your own, and check
      it landed in the inbox rather than in spam.
- [ ] SPF and DKIM pass on that email (view the headers; both should say
      `pass`).
- [ ] TLS certificate installed, HTTP redirects to HTTPS, and
      `certbot renew --dry-run` passes.
- [ ] UptimeRobot is watching `/api/v1/ready` (see **Watching it from outside**).
- [ ] `free -m` checked after day one against the idle-reclamation rule.
- [ ] The first administrator created, and a second admin account exists so one
      lost password is not a lockout.
- [ ] Smoke tests pass against the live URL (below).

---

## Deploying an update

GitHub Actions builds and deploys on a tag. By hand:

```bash
cd /srv/taskmanager

# Always first. Migrations do not roll back, so this is the only way out of
# a release that turns out to have changed the schema destructively. It takes
# seconds and it is off-site before the deploy starts.
docker compose -f docker-compose.prod.yml exec backup /scripts/backup.sh

git fetch --tags
git checkout <tag>
docker compose -f docker-compose.prod.yml build api
docker compose -f docker-compose.prod.yml run --rm --no-deps api \
  node dist/cli/envCheck.js         # the release may have added a variable
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f --tail=50 api worker
```

Migrations run automatically, before the API starts.

### Smoke test after deploying

Run it from your own machine, not the server: it needs Node, and the point
is to exercise the site the way a browser outside the network reaches it.

PowerShell, on Windows:

```powershell
$env:BASE_URL="https://tasks.example.com"
$env:SMOKE_EMAIL="smoke@yourdomain"
$env:SMOKE_PASSWORD="<password>"
pnpm smoke
```

macOS or Linux:

```bash
BASE_URL=https://tasks.example.com \
SMOKE_EMAIL=smoke@yourdomain \
SMOKE_PASSWORD=<password> \
pnpm smoke
```

PowerShell has no inline `VAR=value command` form, so the bash version does
nothing useful there: it sets no variables, and `pnpm smoke` then stops on
an empty `SMOKE_EMAIL`.

It signs in, checks the security headers and the readiness endpoint, then
creates a task in the **Smoke** project, moves it through the workflow and
deletes it again. Writing is the point: a read-only check passes against a
database mounted read-only.

Everything it writes is inside the internal Smoke team, so none of it reaches
the dashboard, the digest or the alerts, and it cleans up after itself. If a
run is interrupted, anything left behind is named `Smoke test <timestamp>` in
that project and can be deleted by hand.

Set `SMOKE_PROJECT` if you called the project something else.

### Rolling back

Every release is tagged, and a rollback is a checkout of **the previous
release tag** followed by a rebuild. Read the tag list rather than guessing a
name:

```bash
git tag -l 'v*' --sort=-creatordate | head
git checkout <the-tag-before-this-one>
docker compose -f docker-compose.prod.yml up -d --build
```

Two things this does not cover.

**The first deploy has no rollback.** There is no previous release on the
server to go back to. If the first one is broken, fix forward, or restore
from backup and start again.

**Migrations do not roll back.** Drizzle migrations here are additive, so an
older application runs against a newer schema and a rollback is safe. A
release that ever adds a destructive migration breaks that, cannot be rolled
back this way, and has to say so in its own notes; the path then is
restore-from-backup.

Which is why every deploy takes a backup first — see the update steps above.

## Watching it from outside

The health checks in the table above are all *inside* the server. They
cannot tell you the box is off, the disk is full or DNS has expired, which
are the outages that actually happen.

**UptimeRobot**, free plan. **Add New Monitor**:

- **Monitor type:** Keyword.
- **URL:** `https://tasks.example.com/api/v1/ready`.
- **Keyword:** `"ready":true`, alert when it **does not exist**. A keyword
  check rather than a plain HTTP one, so a cached or proxied 200 with the
  wrong body does not read as healthy.
- **Interval:** 5 minutes, the free plan's shortest.
- **Alert contacts:** your email, and the UptimeRobot mobile app if you want a
  push notification.

`/ready` rather than `/health`: it returns 503 when the database or the job
queue is unreachable, so an API that is answering but cannot send an
invitation still counts as down. `/health` would say 200 through that.

Certificate-expiry alerts are a paid UptimeRobot feature, and Let's Encrypt
no longer emails expiry warnings. Renewal is automatic (see **TLS**). To check
it is still working, `./scripts/check-tls.sh tasks.example.com` prints the
expiry date: run it monthly. If renewal does stop, the keyword monitor fails
on the day the certificate expires.

---

## Observability

Logs are JSON on stdout in production:

```bash
docker compose -f docker-compose.prod.yml logs -f api worker
```

Every service caps its log at 10MB x 3 files, set once as an anchor at the
top of the Compose file. Docker's default is to keep container logs forever,
and a JSON log file is the usual way a small server fills its disk and stops
accepting writes at four in the morning. If you add a service, give it
`logging: *default-logging` too.

```bash
# What the logs are costing
sudo du -sh /var/lib/docker/containers/*/*-json.log | sort -h | tail
```

`LOG_LEVEL` controls verbosity. Authorization headers, cookies and anything
that looks like a password or token are redacted by the logger.

Worth watching:

- `Unsafe setting for production` — a relaxed test setting reached the server.
- `A revoked refresh token was replayed` — possible stolen session cookie.
- `Could not send a notification email` — SMTP trouble, before users report it.

---

## The whole sequence

Every step of a first deploy, in order, with nothing explained: the sections
above say why. Replace:

| Placeholder | Is |
| --- | --- |
| `<SERVER_IP>` | the VM's public IP |
| `tasks.example.com` | the app's domain |
| `example.com` | the domain mail is sent from |
| `you@example.com` | your own email (Let's Encrypt notices, the first admin) |
| `<repo>` | the Git URL of this repository |

**In the consoles, before touching the server**

1. Oracle: create the instance (`VM.Standard.A1.Flex`, 2 OCPU / 6 GB, Ubuntu
   24.04, your SSH public key, public IPv4).
2. Oracle: security list ingress for TCP 80 and 443 from `0.0.0.0/0`.
3. Oracle: bucket `task-attachments`, user and group `taskmanager-storage`,
   the two-line policy, a Customer Secret Key. Note the namespace.
4. Backblaze: private bucket, lifecycle "Keep only the last version", an
   application key for that bucket only. Note the endpoint and region.
5. Brevo: SMTP key and login; add the sending domain.
6. DNS: `A tasks.example.com → <SERVER_IP>`, plus Brevo's `brevo-code`, the
   two DKIM CNAMEs, SPF and DMARC. Then **Authenticate** in Brevo.

**On the server, as `ubuntu`**

```bash
ssh ubuntu@<SERVER_IP>

# Host firewall: before Docker
N=$(sudo iptables -L INPUT -n --line-numbers | awk '$2 == "REJECT" { print $1; exit }'); echo "$N"
sudo iptables -I INPUT "$N" -p tcp -m state --state NEW --dport 443 -j ACCEPT
sudo iptables -I INPUT "$N" -p tcp -m state --state NEW --dport 80  -j ACCEPT
sudo netfilter-persistent save
grep -E 'dport (80|443)' /etc/iptables/rules.v4

# The deploy user
sudo adduser deploy
sudo usermod -aG sudo deploy
sudo rsync --archive --chown=deploy:deploy /home/ubuntu/.ssh /home/deploy
```

**From a second terminal, as `deploy`**, keeping the first one open:

```bash
ssh deploy@<SERVER_IP>

# PermitRootLogin no, PasswordAuthentication no
sudo nano /etc/ssh/sshd_config
sudo systemctl restart ssh            # then test a fresh login before closing anything

# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy && newgrp docker
docker compose version
docker info --format '{{.Architecture}}'      # aarch64

# Swap
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h

# Security updates
sudo apt update && sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades

# DNS has propagated
dig +short tasks.example.com
curl -fsS https://ifconfig.me && echo

# The code
sudo mkdir -p /srv/taskmanager && sudo chown deploy:deploy /srv/taskmanager
git clone <repo> /srv/taskmanager
cd /srv/taskmanager
git checkout v1.0.0-rc4

# Configuration
cp .env.production.example .env.production
openssl rand -hex 24      # POSTGRES_PASSWORD, and the same value inside DATABASE_URL
openssl rand -hex 32      # JWT_ACCESS_SECRET
nano .env.production      # domain, the three of OCI / Brevo / B2, the two secrets above
chmod 600 .env.production

# Check it, with no Node on the server
docker compose -f docker-compose.prod.yml build api
docker compose -f docker-compose.prod.yml run --rm --no-deps api node dist/cli/envCheck.js

# Start
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps

# TLS
docker compose -f docker-compose.prod.yml run --rm certbot certonly \
  --webroot --webroot-path /var/www/certbot \
  -d tasks.example.com --email you@example.com --agree-tos --no-eff-email
docker compose -f docker-compose.prod.yml exec web /usr/local/bin/use-real-cert
./scripts/check-tls.sh tasks.example.com
ls certs/live/                                  # tasks.example.com only, no -0001
echo | openssl s_client -servername tasks.example.com -connect tasks.example.com:443 2>/dev/null \
  | openssl x509 -noout -issuer -dates          # issuer: Let's Encrypt
docker compose -f docker-compose.prod.yml run --rm certbot renew --dry-run

# The first administrator (prompts for the password)
docker compose -f docker-compose.prod.yml run --rm api \
  node dist/cli/createUser.js --email you@example.com --name "Your Name" --role SUPER_ADMIN
```

**In the browser, at `https://tasks.example.com`, as the administrator**

1. Settings → Organisation: `Asia/Kolkata`, weekend Saturday and Sunday,
   8 working hours, digest `09:00`, week starts Monday.
2. Settings → Holidays: this year's.
3. Settings → Email → Send a test email, to another provider; headers show
   `spf=pass`, `dkim=pass`, `dmarc=pass`.
4. Settings → Teams: `Smoke`, Internal ticked. Settings → Projects: `Smoke`,
   key `SMOKE`. Settings → People: invite `smoke@example.com` as Team Lead of
   Smoke, and set its password from the email.
5. Upload an attachment to any task and download it again.

**Back on the server: backups, proven**

```bash
cd /srv/taskmanager
docker compose -f docker-compose.prod.yml exec backup /scripts/backup.sh
docker compose -f docker-compose.prod.yml exec backup \
  sh -c '. /scripts/rclone-remotes.sh && rclone lsl "backup:$BACKUP_S3_BUCKET/database"'

docker compose -f docker-compose.prod.yml exec postgres \
  sh -c 'createdb -U "$POSTGRES_USER" taskmanager_restore'
docker compose -f docker-compose.prod.yml exec backup sh -c \
  '/scripts/restore.sh remote "postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/taskmanager_restore"'
docker compose -f docker-compose.prod.yml exec postgres \
  sh -c 'dropdb -U "$POSTGRES_USER" taskmanager_restore'
```

**From your Windows machine, in this repository: the smoke test**

```powershell
$env:BASE_URL="https://tasks.example.com"
$env:SMOKE_EMAIL="smoke@example.com"
$env:SMOKE_PASSWORD="<smoke password>"
pnpm smoke
```

**Then**

1. UptimeRobot: Keyword monitor on `https://tasks.example.com/api/v1/ready`,
   keyword `"ready":true`, 5 minutes.
2. The day after: `free -m` on the server. Under 20% in use → Edit shape and
   reduce memory (see **Don't let Oracle reclaim it as idle**).
3. Add a line to the **Restore drill log** above.
