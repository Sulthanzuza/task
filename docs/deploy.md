# Deploying Team Task Manager

Written for whoever runs this on a server, including the version of you that
has forgotten how it works.

One VPS is enough for a team of eight to thirty. The stack is Nginx, one API,
one worker, Postgres, MinIO, a backup job and a watchdog, all from
`docker-compose.prod.yml`.

---

## Before you start

A fresh **Ubuntu 24.04 LTS** box. One VPS with 2 vCPU and 4GB is comfortable
for a team of eight to thirty.

**1. A user that is not root.** Everything below is run as this user.

```bash
adduser deploy && usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

Then, in `/etc/ssh/sshd_config`, `PermitRootLogin no` and
`PasswordAuthentication no`, and `sudo systemctl restart ssh`. Keep your
current session open while you test the new login from another terminal: a
typo here locks you out of the server.

**2. Docker Engine and the Compose plugin.** Not `docker.io` from the Ubuntu
archive, which is older than the Compose file expects.

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker deploy && newgrp docker
docker compose version          # v2.x
```

**3. A firewall that allows three ports.**

> **Docker bypasses ufw.** Publishing a port writes an iptables rule in the
> `DOCKER` chain, which is consulted before ufw's. A container published as
> `5432:5432` is reachable from the internet with ufw showing `deny
> incoming` and no warning anywhere. The only reliable defence is not to
> publish the port: bind it to `127.0.0.1:5432:5432` if you ever need it
> locally, and never to `0.0.0.0`.
>
> In this deployment **only nginx may publish a port**, and it publishes 80
> and 443. Postgres, MinIO, the API and the worker talk to each other over
> the Compose network and are not reachable from outside the host. If you
> add a service, do not give it a `ports:` entry.

ufw is still worth having for everything that is not Docker — ssh, anything
you install later — and for the day somebody adds a published port by
mistake and you want the rest of the box covered.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

**4. Swap, so a build does not kill the box.** 4GB is enough to run this and
not enough to run `pnpm build` inside Docker at the same time as Postgres.
Without swap the kernel's OOM killer picks a victim, and it is usually
Postgres.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h                                 # Swap: 2.0Gi
```

**5. Security updates, applied on their own.**

```bash
sudo apt update && sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades    # answer Yes
systemctl status unattended-upgrades --no-pager | head -3
```

This takes security patches only, and does not reboot by itself. Kernel
updates still need a reboot you schedule.

**6. DNS pointing here, before certbot runs.** Let's Encrypt resolves the name
itself, so a record that has not propagated is a failed issuance and a rate
limit you then wait out.

```bash
dig +short tasks.example.com          # must print this server's public IP
curl -fsS https://ifconfig.me && echo  # which is this
```

**7. The code.**

```bash
sudo mkdir -p /srv/taskmanager && sudo chown deploy:deploy /srv/taskmanager
git clone <repo> /srv/taskmanager
cd /srv/taskmanager
git checkout v1.0.0-rc2
```

**8. An SMTP provider with SPF and DKIM** (see below). Without them,
invitations and alerts land in spam and the product looks broken on day one.

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
| `POSTGRES_USER` | anything, e.g. `taskmanager` | — |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | — |
| `POSTGRES_DB` | anything, e.g. `taskmanager` | — |
| `JWT_ACCESS_SECRET` | `openssl rand -hex 32` | under 32 characters, or left as the development default |
| `S3_ACCESS_KEY_ID` | `openssl rand -hex 16` | — |
| `S3_SECRET_ACCESS_KEY` | `openssl rand -hex 24` | — |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION` | leave the defaults for the bundled MinIO | — |
| `STORAGE_DRIVER` | `s3` | `local` is refused: it keeps uploads on one container's disk |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | from your mail provider | — |
| `MAIL_FROM` | `Task Manager <no-reply@yourdomain>` | — |
| `MAIL_ENABLED` | `true` | `false` is refused in production |
| `JOB_QUEUE_ENABLED` | `true` | `false` is refused in production |
| `BACKUP_S3_ENDPOINT` | your off-site provider's S3 endpoint | the backup job will not run without it |
| `BACKUP_S3_BUCKET` | the bucket you made there | as above |
| `BACKUP_S3_ACCESS_KEY` / `BACKUP_S3_SECRET_KEY` | from that provider | as above |
| `WORKER_HEALTH_PORT` | `4001` | unset means the worker serves no health endpoint and the watchdog cannot see it |
| `NODE_ENV` | `production` | anything else turns the production checks off |

The rest have working defaults. `CORS_ORIGINS` stays empty: the app and the
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
sends **no email**, so this works before SMTP is proven and nothing here
depends on a set-password link arriving.

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

Signed in as the administrator:

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

Fix SPF and DKIM at your DNS provider before going on (see below).

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

## Email: SPF and DKIM

Both are DNS records on the sending domain. Skipping them is the most common
reason a new deployment's mail silently disappears.

**SPF** — one TXT record on the root, listing who may send as you:

```
tasks.example.com.  TXT  "v=spf1 include:<your-provider-spf> -all"
```

**DKIM** — a TXT record on the selector your provider gives you:

```
<selector>._domainkey.tasks.example.com.  TXT  "v=DKIM1; k=rsa; p=<public key>"
```

**DMARC** — worth adding once the first two are in place:

```
_dmarc.tasks.example.com.  TXT  "v=DMARC1; p=quarantine; rua=mailto:postmaster@example.com"
```

Verify by sending a test from **Settings → Notifications → Send a test email**,
then checking the received message shows `spf=pass` and `dkim=pass` in its
headers. Do this before inviting anybody.

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

Configure `BACKUP_S3_*` in `.env.production` with a bucket at Backblaze B2,
Cloudflare R2, Wasabi or anything else with an S3 endpoint. Use credentials
scoped to that one bucket, so a key taken from this server cannot reach
anything else.

Retention is 14 days off-site and 3 days locally, the local copies being a
convenience for a fast restore rather than the backup.

```bash
# On demand, rather than waiting for the nightly run
docker compose -f docker-compose.prod.yml exec backup /scripts/backup.sh

# What is off-site. Single quotes and sh -c, so $BACKUP_S3_BUCKET is
# expanded inside the container where it has a value: your shell would
# expand it to nothing and you would list the wrong path and see nothing,
# which looks exactly like a backup that is not running.
docker compose -f docker-compose.prod.yml exec backup \
  sh -c 'mc ls backup/$BACKUP_S3_BUCKET/database/'
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

- [x] Nightly backup has run at least once, and the dump is in the off-site bucket.
- [x] A restore **from the off-site copy** into a scratch database has succeeded.
- [ ] A test email has actually arrived. **Settings → Email → Send a test
      email**, to an address on a different provider from your own, and check
      it landed in the inbox rather than in spam.
- [ ] SPF and DKIM pass on that email (view the headers; both should say
      `pass`).
- [ ] TLS certificate installed, HTTP redirects to HTTPS, and
      `certbot renew --dry-run` passes.
- [ ] An external uptime check is watching `/api/v1/ready`.
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

Point an external monitor at **`https://tasks.example.com/api/v1/ready`**,
every minute, alerting after two consecutive failures. UptimeRobot, Better
Stack and Healthchecks.io all have a free tier that covers this.

`/ready` rather than `/health`: it returns 503 when the database or the job
queue is unreachable, so an API that is answering but cannot send an
invitation still counts as down. `/health` would say 200 through that.

Two more worth having, if the monitor supports them:

- **Certificate expiry**, warning at 14 days. Renewal is automatic, and this
  is what tells you when it has silently stopped working.
- **Keyword check** on `"ready":true`, so a cached or proxied 200 with the
  wrong body does not read as healthy.

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
