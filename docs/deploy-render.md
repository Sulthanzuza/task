# Deploying on Render and Supabase (free, no credit card)

Written for whoever sets this up, start to finish, with nothing but a browser,
this repository on a Windows machine, and free accounts. Every console click is
here, in order. For the Docker deployment on a VM of your own, see
[`deploy.md`](deploy.md).

**The launch needs no email and no domain.** The app runs at Render's own
address, `https://<service>.onrender.com`, and sends no email
(`MAIL_TRANSPORT=none`): invitations and password resets are links an admin
copies from **Admin → People** and sends however the team talks, and
notifications and the daily digest are in the app. Email (Brevo) and a custom
domain can be added later without redeploying anything but configuration:
see **Later: email, and a domain of your own** at the end.

## What runs where

| What | Where | Free allowance |
| --- | --- | --- |
| The app: web app, API, Socket.IO and job worker, **one process** | Render free web service, Singapore, at `https://<service>.onrender.com` | 512 MB, 0.1 CPU, 750 instance hours a month per workspace |
| Database | Supabase, Singapore, Session pooler, TLS verified | 500 MB |
| Attachments | Supabase Storage, through its S3 protocol | 1 GB |
| Email | none at launch; invitation and reset links are copied by an admin | — |
| Nightly backups and restore drills | GitHub Actions → Backblaze B2 | 2,000 Actions minutes a month (private repo), 10 GB on B2 |
| Uptime and keep-awake | UptimeRobot, every 5 minutes | 50 monitors |

The code is the same as the Docker deployment. What differs is configuration,
in `render.yaml`:

- **`RUN_MODE=all`**: `dist/server.js` runs the HTTP server, Socket.IO and the
  pg-boss worker together, and serves the built web app with an SPA fallback,
  so everything is one origin and the session cookie stays first-party. The
  Docker deployment still runs `server.js` and `worker.js` as separate
  containers.
- **`MAIL_TRANSPORT=none`**: no email. The app starts with a warning saying so,
  rather than refusing. Every invitation and reset produces a link for an
  admin to copy; the bell and each day's digest page carry what email would
  have. The forgot-password page tells people to ask their admin.
- **`DATABASE_MAX_CONNECTIONS=5`**: three for the app, two for pg-boss, never
  more in total.
- **`NODE_OPTIONS=--max-old-space-size=384`** and argon2id at 19 MiB, two
  passes, one lane (OWASP's minimum), so a sign-in fits in 512 MB.
- **`DATABASE_CA_CERT`**: Supabase's CA. Every database connection is TLS and
  the server's certificate is verified against it, host name included; in
  production the app refuses to start without it.
- **Migrations take an advisory lock**, so two instances starting together
  cannot migrate at the same time: the second waits, then finds nothing to do.
- **Cookies are host-only.** `COOKIE_DOMAIN` is empty, so the session cookie
  belongs to `<service>.onrender.com` and nothing else. (It could not be set
  for `onrender.com` anyway: that is a public suffix, shared by every Render
  app, and browsers refuse cookies for it.) `CORS_ORIGINS` is empty too: the
  app and the API are the same origin, so there is no cross-origin caller to
  allow, and `WEB_ORIGIN` is always allowed.

### What the free plan cannot do, and what this deployment does instead

| Render free does not have | Instead |
| --- | --- |
| A pre-deploy command | The image's start command runs `migrate` and then the server, under a Postgres advisory lock so that only one instance migrates at a time. A failed migration stops the start, so nothing serves on a half-migrated schema; migrations are idempotent, so a restart finds nothing to do. |
| Shell, SSH or one-off jobs | The first administrator is created by the service itself on its first start, from `BOOTSTRAP_ADMIN_EMAIL`, or from your own machine against the database (step 6). |
| Outbound SMTP | No email at launch; Brevo's HTTP API later, if wanted. |
| A persistent disk | Attachments in Supabase Storage; nothing is written to the instance's disk. |
| Cron jobs | Backups run in GitHub Actions; the app's own schedules (alerts, digest) run inside pg-boss. |

### The limits, and what they mean here

- **0.1 CPU.** Fine for a team of eight to thirty, but CPU-bound work is
  slow: a sign-in (argon2id is deliberately expensive) takes noticeably
  longer than on a laptop, and a cold start took 28 seconds to pass the
  health check, migrations included, in a rehearsal capped at 0.1 CPU.
- **512 MB.** The process idles at about 50 MB. Uploads are capped at 25 MB
  and downloads are streamed, never held in memory whole.
- **Sleeps after 15 minutes without traffic.** UptimeRobot calls
  `/api/v1/ready` every 5 minutes, so it never does. That uses about 744 of
  the workspace's 750 free hours a month: **this must be the only free web
  service in the Render workspace**, or the hours run out before the month
  does.
- **Restarts at any time.** Render may restart a free service whenever it
  likes. Nothing is lost: sessions, jobs and files all live outside the
  instance. Open sockets reconnect by themselves.
- **5 GB of outbound bandwidth a month** (check **Workspace → Billing →
  Usage** for your current allowance). Every attachment download goes through
  Render, so a team that passes large files around is what uses it up. With
  no card on file, going over suspends the service until the next month.
- **Supabase pauses a project after 7 days without database activity.** The
  monitor's `/ready` queries the database every 5 minutes, and pg-boss's own
  maintenance and the scheduled alert scan write to it continuously, so it
  stays active. If the monitor stops and the app sleeps for a week, the
  project pauses: restore it from the Supabase dashboard (**Restore
  project**), then wake Render by opening the site.
- **Both in Singapore.** Render has no region in India, and Singapore is the
  nearest. The Supabase project goes there too: a page makes several database
  round trips, and keeping the app next to its database makes each one about
  a millisecond instead of the 60 ms a Mumbai database would cost. People in
  India see one longer hop, to Singapore, once per request.

---

## 1. GitHub: the private repository

Render deploys from GitHub, and the backups run in GitHub Actions. The code is
in the private repository `https://github.com/Sulthanzuza/task`, branch `main`,
with every release tagged.

To push later work, from PowerShell in the repository: check nothing secret is
staged, then push.

```powershell
git status --short                 # nothing unexpected
git check-ignore -v .env .env.production backups certs apps/web/e2e/.shots
# each one must print the .gitignore rule that ignores it
git ls-files | Select-String -Pattern '^\.env|^backups/|^certs/|\.shots/|\.pem$|\.dump$'
# must print only .env.example and .env.production.example

git push origin main
git push origin --tags
```

Every push to `main` redeploys on Render (step 4).

---

## 2. Supabase: database and storage (Singapore)

**2.1 The project.** supabase.com → **Start your project** → sign in with
GitHub → **New project**:

- **Organization:** your personal one (Free plan).
- **Project name:** `taskmanager`
- **Database password:** **Generate a password**, then **copy it into your
  password manager now**. It is needed twice below and not shown again.
- **Region:** **Southeast Asia (Singapore)**, `ap-southeast-1`, the same
  region as the Render service.
- **Create new project**, and wait a couple of minutes for it to finish.

**2.2 The connection string: Session pooler.** Top bar → **Connect** →
**Connection String** tab → **Method: Session pooler** → copy the URI:

```
postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
```

- **Session pooler, port 5432.** Not **Direct connection**, which is IPv6
  only and unreachable from Render or GitHub Actions. Not the **Transaction
  pooler** on 6543, which hands each statement to a different connection and
  breaks pg-boss.
- Replace `[YOUR-PASSWORD]` with the database password. If it contains any of
  `@ : / ? # [ ] %`, percent-encode those characters (`@` is `%40`), or
  regenerate a password without them.
- **Nothing after `/postgres`**: no `?sslmode=...`. TLS comes from the
  certificate in 2.3, and the app refuses a URL that also sets it, because the
  driver would let the URL's setting replace verification. The same URL is used
  everywhere: Render, the first admin, and the GitHub Actions backup.

**2.3 The database's CA certificate.** **Project Settings → Database →
SSL Configuration → Download certificate**. It saves a `.crt` file, PEM text
beginning `-----BEGIN CERTIFICATE-----`. Keep it next to the password: it is
not secret, but every connection is checked against it, so a wrong one stops
the app from starting. It goes, as text, into Render (`DATABASE_CA_CERT`), into
a GitHub secret of the same name, and into PowerShell for the first admin.

While on that page, **Enforce SSL on incoming connections** can be switched
on: the app and the backups only ever connect over TLS.

**2.4 The storage bucket.** Left sidebar → **Storage** → **New bucket**:

- **Name:** `task-attachments`
- **Public bucket:** off. The API checks permissions on every download.
- **Restrict file size:** on, **25 MB** (the app's own limit).
- **Create**.

**2.5 S3 access.** **Storage** → **Settings** (or **S3 Configuration**):

- **Enable connection via S3 protocol:** on, **Save**.
- Copy the **Endpoint**, `https://<ref>.storage.supabase.co/storage/v1/s3`.
  The **Region** shown is `ap-southeast-1`, which `render.yaml` already
  sets.
- **S3 Access Keys → New access key** → description `taskmanager-render` →
  **Create access key**. Copy the **Access key ID** and the **Secret access
  key** now: the secret is shown once.

These keys can read and write every bucket in the project, bypassing row
level security. They are a secret like the database password.

---

## 3. Backblaze B2: off-site backups

Exactly as in [`deploy.md`, **Backblaze B2**](deploy.md#backblaze-b2):

1. **Buckets → Create a Bucket**: `<yourcompany>-taskmanager-backup`,
   **Private**, encryption on. Note the **Endpoint** `s3.<region>.backblazeb2.com`
   and the region in the middle of it.
2. **Lifecycle Settings → Keep only the last version of the file.** Without
   it, every dump the 14-day retention deletes is only hidden, and stays.
3. **Application Keys → Add a New Application Key**: access to **this bucket
   only**, **Read and Write**. Copy `keyID` and `applicationKey` (shown once).

---

## 4. Render: the Blueprint

**4.1 Sign up.** render.com → **Get Started** → **GitHub**. No card is asked
for. Allow Render access to the `task` repository only.

**4.2 Create from the Blueprint.** **New +** → **Blueprint** → choose
`Sulthanzuza/task` → **Blueprint Name** `taskmanager`, branch `main`. Render
reads `render.yaml` and shows one **free web service**, `taskmanager`, in
Singapore, and asks for every `sync: false` value:

| Key | Value |
| --- | --- |
| `WEB_ORIGIN` | `https://taskmanager.onrender.com` (corrected in 4.4 if Render picks another name) |
| `DATABASE_URL` | the Session pooler URI from 2.2, ending `/postgres` |
| `DATABASE_CA_CERT` | the whole certificate from 2.3: open the `.crt` file in Notepad, copy everything from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`, and paste it, line breaks and all |
| `S3_ENDPOINT` | `https://<ref>.storage.supabase.co/storage/v1/s3` |
| `S3_ACCESS_KEY_ID` | from 2.5 |
| `S3_SECRET_ACCESS_KEY` | from 2.5 |
| `BOOTSTRAP_ADMIN_EMAIL` | optional: your own email, to have the first administrator created on the first start (step 6) |
| `BOOTSTRAP_ADMIN_NAME` | optional: your name, for that administrator |

`JWT_ACCESS_SECRET` is generated by Render; everything else, the region and
`MAIL_TRANSPORT=none` included, has its value in `render.yaml`. **Apply**.

**4.3 Watch the first deploy.** **Dashboard → taskmanager → Logs**. The build
takes several minutes on the free builder. Then, in order:

```
Migrations applied.
Unsafe setting for production.  MAIL_TRANSPORT is none: no email is sent. ...
API listening.          {"mode":"all"}
Schedules registered.
Job worker listening.
```

The `MAIL_TRANSPORT is none` warning is expected, and repeats at every start
as a reminder. The service turns **Live** once `/api/v1/ready` answers 200. If
it stops at `Refusing to start in production:` instead, the lines after it
name every setting that is wrong. A certificate problem shows as `Migration
failed` with `self-signed certificate in certificate chain` (the wrong CA in
`DATABASE_CA_CERT`) or `does not match` (a host name other than the pooler's).

**4.4 Correct `WEB_ORIGIN` if needed.** The URL is at the top of the service
page. If it is not `https://taskmanager.onrender.com` (the name may be taken,
and Render adds a suffix): **Environment** → `WEB_ORIGIN` → **Edit** → the
real URL, `https://` and no trailing slash → **Save, rebuild, and deploy**.
Invitation and reset links are built from it, so they must match the address
people actually open.

**4.5 Updates.** Every push to `main` deploys, migrations first. To go back:
**Events** → an earlier deploy → **Rollback**. Migrations are additive, so an
older release runs against a newer schema.

---

## 5. UptimeRobot: monitor and keep-awake

uptimerobot.com → sign up → **+ New monitor**:

- **Monitor Type:** Keyword.
- **URL:** `https://taskmanager.onrender.com/api/v1/ready`
- **Keyword:** `"ready":true`, alert when it **does not exist**.
- **Monitoring Interval:** 5 minutes.
- **Alert contacts:** your own email: UptimeRobot sends this, not the app.
- **Create Monitor**.

Every 5 minutes is what keeps Render from sleeping (15 minutes) and Supabase
from pausing (7 days). It is also the alert when either is down: `/ready`
returns 503 when the database or the job queue is unreachable.

---

## 6. The first administrator

Render's free tier has no Shell, so there are two ways. Use one.

### 6A. By the service itself, on its first start (simplest)

With `BOOTSTRAP_ADMIN_EMAIL` (and `BOOTSTRAP_ADMIN_NAME`) filled in at 4.2,
the first start against the empty database creates that person as
**Super admin**, with no password, and writes a link to choose one into the
log:

1. **Dashboard → taskmanager → Logs**, and find the **WARN** line
   `Bootstrap: created the first administrator.` Its `setPasswordLink` field
   is `https://taskmanager.onrender.com/reset-password?token=...`.
2. Open that link, choose your password (at least 10 characters, upper, lower
   and a digit), and sign in with the bootstrap email.
3. **Then remove both variables:** **Environment** → `BOOTSTRAP_ADMIN_EMAIL` →
   delete, `BOOTSTRAP_ADMIN_NAME` → delete → **Save, rebuild, and deploy**.

What it will and will not do:

- It acts **only when the users table is empty**. On every later start it
  logs `Bootstrap skipped: users already exist` and does nothing: it never
  creates a second admin and never resets anyone's password, whatever the
  variables say. Two instances starting together still make one admin.
- The link works **once**, for **24 hours**. Only its hash is stored; the raw
  token is in that one log line and nowhere else.
- **Anyone who can read this service's logs in those 24 hours could use the
  link**, which is why you use it at once and why the variables come out
  afterwards. If it expires unused, the account exists with no password and
  the bootstrap will not run again (there is a user now). Create an admin from
  your machine with 6B, under another email, sign in as them, and use
  **Admin → People → Reset link** on the bootstrap account to give it a fresh
  link.

### 6B. From your machine

The account is created from this repository on your Windows machine, against
the Supabase database. The CLI prompts for the password and stores only its
hash; it sends no email.

```powershell
cd C:\path\to\task
git pull
pnpm install

# Read-Host keeps the URL, and the password inside it, out of PowerShell's history.
$env:DATABASE_URL = Read-Host "Session pooler URL (ending /postgres)"
# The certificate from 2.3, so this connection is verified like the app's.
$env:DATABASE_CA_CERT = Get-Content -Raw "<path to the .crt file from 2.3>"

pnpm admin:create-user --email you@example.com --name "Your Name" --role SUPER_ADMIN
# Password: (typed, not shown) - at least 10 characters, upper, lower and a digit

Remove-Item Env:DATABASE_URL, Env:DATABASE_CA_CERT
```

There is deliberately no "create the first admin" page: that would be a race
with whoever finds the deployment first.

---

## 7. Organisation settings, holidays, and inviting people

Sign in at `https://taskmanager.onrender.com`. "Settings" is the **More**
menu (the gear). Do the first two before inviting anybody: every business date
is computed from them, and changing them later moves dates on existing work.

1. **Settings → Organisation:** time zone `Asia/Kolkata`; weekend Saturday
   and Sunday; working hours `8`; daily digest `09:00`; week starts Monday.
   **Save**.
2. **Settings → Holidays:** this year's public holidays.
3. **Settings → Email** says **Email is turned off**. That is right for the
   launch; the digest preview on that page still shows what each person's
   in-app digest holds.
4. **The smoke team**, as in
   [`deploy.md`, **The smoke team**](deploy.md#7-the-smoke-team): team
   `Smoke` with **Internal team** ticked, and project `Smoke` with key
   `SMOKE`. Then invite `smoke@example.com` as its Team Lead, as below, open
   the invite link yourself, and set its password.
5. Upload a file to any task and download it again: that is Supabase
   Storage working.
6. **Reports → the overdue trend** will be empty, and says so. The nightly
   job (23:50 in the org time zone) starts recording from the first night it
   runs, so there is nothing behind today yet. If this deployment already has
   history worth charting, rebuild it once from Render → the `api` service →
   **Shell**:

   ```
   node dist/cli/backfillSnapshots.js --days 90
   ```

   That reconstructs open and overdue from the tasks as they stand now. It
   leaves blocked and waiting-review at zero, because neither can be
   recovered from a current row, and the chart marks rebuilt days as
   estimated rather than passing a reconstruction off as a measurement. It is
   safe to run twice: days the job really measured are never overwritten.

**Inviting someone.** **Admin → People → Invite someone** → name, email,
role, teams → **Send the invitation**. A box shows their **invite link**:
**Copy**, and send it to them directly (a direct message, not a group). It
works once and for 7 days. They open it, choose their password, and sign in.
The link is not shown again; if it is lost, **New invite link** on their row
makes another and retires the first.

**When someone forgets their password.** The forgot-password page tells them
to ask their admin. **Admin → People → Reset link** on their row makes a
one-time link, valid for 24 hours, that retires any earlier one; copy it and
send it to them. Their old password keeps working until they use it. Every
link issued is recorded in **Settings → Audit**.

---

## 8. Smoke test, from Windows PowerShell

From the repository on your machine:

```powershell
$env:BASE_URL = "https://taskmanager.onrender.com"
$env:SMOKE_EMAIL = "smoke@example.com"
$env:SMOKE_PASSWORD = Read-Host "Smoke account password"
pnpm smoke
Remove-Item Env:SMOKE_PASSWORD
```

It signs in, checks the security headers and `/ready`, then creates a task in
the Smoke project, moves it through the workflow and deletes it again.

---

## 9. The first backup, and a restore drill

**9.1 The secrets.** GitHub → `Sulthanzuza/task` → **Settings → Secrets and
variables → Actions → New repository secret**, one each:

| Secret | Value |
| --- | --- |
| `DATABASE_URL` | the Session pooler URI from 2.2, as on Render |
| `DATABASE_CA_CERT` | the certificate text from 2.3, as on Render. The backup connects with `sslmode=verify-full` against it |
| `S3_ENDPOINT` | as on Render |
| `S3_REGION` | `ap-southeast-1` |
| `S3_BUCKET` | `task-attachments` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | as on Render |
| `BACKUP_S3_ENDPOINT` | `https://s3.<region>.backblazeb2.com` |
| `BACKUP_S3_REGION` | `<region>` |
| `BACKUP_S3_BUCKET` | the B2 bucket |
| `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` | the B2 `keyID`, `applicationKey` |

Until these exist, the nightly run fails; disable it until then if the
failure emails are a nuisance: **Actions → Backup → ⋯ → Disable workflow**.

**9.2 The first backup.** **Actions → Backup → Run workflow → Run
workflow**. It takes two or three minutes: it builds the backup image with
`pg_dump` 17, dumps the app's schemas (`public`, `pgboss`, `drizzle`, not
Supabase's own) through the Session pooler, copies the Storage bucket, and
prunes dumps older than 14 days. The log ends `Backup complete`; the B2 bucket
now has `database/taskmanager-<stamp>.dump` and `files/`.

After this it runs every night at 02:30 India time (21:00 UTC). GitHub can
start a scheduled run some minutes late.

**9.3 The restore drill.** **Actions → Restore drill → Run workflow**,
target **local**, dump `latest`. It restores the newest off-site dump into a
throwaway Postgres 17 inside the run and fails unless users and tasks come
back. The log ends `Restored N users and M tasks` and `Restore verified`.

**Into Supabase itself**, once: create a second free project,
`taskmanager-scratch` (the free plan allows two), in Singapore too, add its
Session pooler URI as the secret `SCRATCH_DATABASE_URL` and its certificate
(2.3, from the scratch project) as `SCRATCH_DATABASE_CA_CERT`, and run the
drill with target **scratch**. Without `SCRATCH_DATABASE_CA_CERT` the drill
uses `DATABASE_CA_CERT`. That wipes and refills the scratch project's
app schemas. It refuses to run against the production database, by user,
host and database name, whatever the secrets say. Pause or delete the scratch
project afterwards so it does not count against anything.

Add a line to the **Restore drill log** in `deploy.md`. Repeat the drill once
a quarter.

---

## When something is wrong

| Symptom | Look at |
| --- | --- |
| Deploy fails at start with `Refusing to start in production` | The lines after it, in **Logs**: each names a setting. |
| `Migration failed` | The database URL (Session pooler, port 5432, password encoded, nothing after `/postgres`), and the Supabase project not being paused. |
| `self-signed certificate in certificate chain` | `DATABASE_CA_CERT` is not this project's certificate, or was pasted without its first or last line. |
| `does not match` (host name) | `DATABASE_URL` points at a host the certificate does not name: use the pooler host exactly as Supabase shows it. |
| `/ready` says `"queue":false` | pg-boss could not connect: the same URL checks, or the 5-connection budget exceeded by something else connecting as `postgres`. |
| An invite or reset link says it has expired | It was used already, is past its expiry (7 days for an invite, 24 hours for a reset), or a newer one was made since. Make a new one in **Admin → People**. |
| A link opens the wrong address | `WEB_ORIGIN` is not the address people use (4.4). |
| Uploads fail | `S3_*` values, **S3 protocol** enabled on Supabase, and the bucket name. |
| Site takes 30 seconds to open | It was asleep: check the UptimeRobot monitor is running. |
| Supabase says the project is paused | **Restore project** in the Supabase dashboard; then the monitor and the app keep it awake. |

---

## Later: email, and a domain of your own

Neither is needed to run. Both are configuration on the running service, in
any order.

### A. Email through Brevo

Render's free tier blocks SMTP, so this uses Brevo's HTTP API rather than the
SMTP relay in `deploy.md`. It needs a domain to send from, with DNS you can
edit.

**A.1 The sending domain.** brevo.com → sign up (no card) → **Senders,
Domains & Dedicated IPs → Domains → Add a domain**: the domain mail will come
from. Brevo lists the records to create at your DNS provider: a `brevo-code`
TXT, two DKIM CNAMEs, and SPF and DMARC. Their shape, and the one-SPF-record
rule, are in [`deploy.md`, **Email: Brevo**](deploy.md#email-brevo). Then
**Authenticate this email domain**.

**A.2 The sender.** **Senders → Add a sender**: name `Task Manager`, email
`no-reply@<that domain>`.

**A.3 The API key.** Profile menu → **SMTP & API** → **API Keys** tab →
**Generate a new API key** → name `taskmanager-render` → copy it (it starts
`xkeysib-`). An **API key**, not an SMTP key.

**A.4 Let Render's addresses call Brevo.** Brevo blocks API calls from
addresses it has not authorised, which is worth keeping: a leaked key is then
useless from anywhere else.

1. In Render: the service → **Connect** (top right) → **Outbound** tab. It
   lists the IP ranges, in CIDR notation, that services in Singapore send
   from. Render's page on them:
   [Outbound IP addresses](https://render.com/docs/outbound-ip-addresses).
2. In Brevo: **Settings → Security → Authorized IPs** → add **each** range, one
   per line, exactly as Render shows it (Brevo accepts CIDR ranges):
   [Brevo: authorise IP addresses](https://help.brevo.com/hc/en-us/articles/5740111683858).
3. Leave blocking of unknown addresses **on**.

Render can add ranges to a region; if mail ever starts failing with Brevo's
`401` and "unrecognised IP address" in the **Logs**, compare the two lists
again.

**A.5 Turn it on.** Render → the service → **Environment**:

| Key | Value |
| --- | --- |
| `MAIL_TRANSPORT` | change `none` to `brevo-api` |
| `BREVO_API_KEY` | add: `xkeysib-...` |
| `MAIL_FROM` | add: `Task Manager <no-reply@<that domain>>` |

**Save, rebuild, and deploy.** The `MAIL_TRANSPORT is none` warning is gone
from the log. Then **Settings → Email → Send a test email**, to an address at
another provider; in the received message's headers (Gmail: ⋮ → **Show
original**): `spf=pass`, `dkim=pass`, `dmarc=pass`.

From then on invitations, resets and notifications are emailed as well. Admins
still get the copyable link with every invitation, and **Reset link** still
works: it is never emailed, so it stays the way back in when someone's email is
not arriving. If emails go missing, the **Logs** show `Brevo refused the email
(...)`: a 401 is the key or an address Brevo has not authorised (A.4); a 400 is
usually an unauthenticated `MAIL_FROM` domain.

### B. A custom domain

For example `tasks.<your domain>` instead of `taskmanager.onrender.com`.

1. Render → the service → **Settings → Custom Domains → Add Custom Domain** →
   the name. Render shows a `CNAME` to create at your DNS provider, pointing at
   `taskmanager.onrender.com`. Create it; Render verifies it and issues the
   certificate itself.
2. **Environment** → `WEB_ORIGIN` → `https://tasks.<your domain>` → **Save,
   rebuild, and deploy**. Links in invitations, resets and emails use it from
   then on. `COOKIE_DOMAIN` stays empty (a host-only cookie on the new name)
   and `CORS_ORIGINS` stays empty (still one origin).
3. UptimeRobot: change the monitor's URL to the new address.
4. People sign in again once, on the new address: the session cookie belonged
   to the old one. Invite and reset links issued before the change still point
   at `onrender.com`; they work there, but make new ones if that is confusing.

The `onrender.com` address still answers, but links and emails all point at
the new name, so that is the one to give people and to bookmark.
