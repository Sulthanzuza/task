# Deploying on Render and Supabase (free, no credit card)

Written for whoever sets this up, start to finish, with nothing but a browser,
this repository on a Windows machine, and free accounts. Every console click is
here, in order. For the Docker deployment on a VM of your own, see
[`deploy.md`](deploy.md).

## What runs where

| What | Where | Free allowance |
| --- | --- | --- |
| The app: web app, API, Socket.IO and job worker, **one process** | Render free web service, Singapore | 512 MB, 0.1 CPU, 750 instance hours a month per workspace |
| Database | Supabase, Singapore, Session pooler, TLS verified | 500 MB |
| Attachments | Supabase Storage, through its S3 protocol | 1 GB |
| Email | Brevo transactional API (HTTPS) | 300 emails a day |
| Nightly backups and restore drills | GitHub Actions → Backblaze B2 | 2,000 Actions minutes a month (private repo), 10 GB on B2 |
| Uptime and keep-awake | UptimeRobot, every 5 minutes | 50 monitors |

The code is the same as the Docker deployment. What differs is configuration,
in `render.yaml`:

- **`RUN_MODE=all`**: `dist/server.js` runs the HTTP server, Socket.IO and the
  pg-boss worker together, and serves the built web app with an SPA fallback,
  so everything is one origin and the session cookie stays first-party. The
  Docker deployment still runs `server.js` and `worker.js` as separate
  containers.
- **`MAIL_TRANSPORT=brevo-api`**: Render's free tier blocks outbound SMTP
  (ports 25, 465 and 587), so mail goes to Brevo over HTTPS. Same templates;
  notification emails are still retried by pg-boss.
- **`DATABASE_MAX_CONNECTIONS=5`**: three for the app, two for pg-boss, never
  more in total.
- **`NODE_OPTIONS=--max-old-space-size=384`** and argon2id at 19 MiB, two
  passes, one lane (OWASP's minimum), so a sign-in fits in 512 MB.
- **`DATABASE_CA_CERT`**: Supabase's CA. Every database connection is TLS and
  the server's certificate is verified against it, host name included; in
  production the app refuses to start without it.
- **Migrations take an advisory lock**, so two instances starting together
  cannot migrate at the same time: the second waits, then finds nothing to do.

### What the free plan cannot do, and what this deployment does instead

| Render free does not have | Instead |
| --- | --- |
| A pre-deploy command | The image's start command runs `migrate` and then the server, under a Postgres advisory lock so that only one instance migrates at a time. A failed migration stops the start, so nothing serves on a half-migrated schema; migrations are idempotent, so a restart finds nothing to do. |
| Shell, SSH or one-off jobs | The first administrator is created from your own machine, against the database (step 7). |
| Outbound SMTP | Brevo's HTTP API. |
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

## 1. GitHub: a private repository

Render deploys from GitHub, and the backups run in GitHub Actions.

**1.1 Check nothing secret is about to be pushed.** In PowerShell, in the
repository:

```powershell
git status --short                 # nothing unexpected
git check-ignore -v .env .env.production backups certs apps/web/e2e/.shots
# each one must print the .gitignore rule that ignores it
git ls-files | Select-String -Pattern '^\.env|^backups/|^certs/|\.shots/|\.pem$|\.dump$'
# must print only .env.example and .env.production.example
```

**1.2 The branch is `main`.** `render.yaml` and CI both follow `main`:

```powershell
git branch --show-current          # if it says master:
git branch -m master main
```

**1.3 Create the repository.** github.com → **+** (top right) → **New
repository**:

- **Repository name:** `task-manager`
- **Private**
- **No** README, **no** .gitignore, **no** licence: the repository must be
  empty, or the first push is refused.
- **Create repository**.

**1.4 Push `main` and every tag:**

```powershell
git remote add origin https://github.com/<your-account>/task-manager.git
git push -u origin main
git push origin --tags             # v0.1-core, v1.0.0-rc1 ... and v1.0.0-render-rc1
git ls-remote --tags origin        # the same list
```

The first push opens a browser window to sign in to GitHub.

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

## 3. Brevo: the email API

Render's free tier blocks SMTP, so this uses Brevo's HTTP API rather than
the SMTP relay in `deploy.md`. The sending domain is set up the same way.

**3.1 The sending domain.** brevo.com → sign up (no card) → **Senders,
Domains & Dedicated IPs → Domains → Add a domain**: the domain in `MAIL_FROM`.
Brevo lists the records to create at your DNS provider: a `brevo-code` TXT,
two DKIM CNAMEs, and SPF and DMARC. Their shape, and the one-SPF-record rule,
are in [`deploy.md`, **Email: Brevo**](deploy.md#email-brevo). Then
**Authenticate this email domain**.

**3.2 The sender.** **Senders → Add a sender**: name `Task Manager`, email
`no-reply@example.com`.

**3.3 The API key.** Profile menu → **SMTP & API** → **API Keys** tab →
**Generate a new API key** → name `taskmanager-render` → copy it (it starts
`xkeysib-`). An **API key**, not an SMTP key.

**3.4 Authorised IPs: after step 5.** Brevo refuses API calls from addresses
it has not authorised. Render's outbound ranges for Singapore are only shown
once the service exists, so this is done in **5.5**, and the blocking stays
on.

---

## 4. Backblaze B2: off-site backups

Exactly as in [`deploy.md`, **Backblaze B2**](deploy.md#backblaze-b2):

1. **Buckets → Create a Bucket**: `<yourcompany>-taskmanager-backup`,
   **Private**, encryption on. Note the **Endpoint** `s3.<region>.backblazeb2.com`
   and the region in the middle of it.
2. **Lifecycle Settings → Keep only the last version of the file.** Without
   it, every dump the 14-day retention deletes is only hidden, and stays.
3. **Application Keys → Add a New Application Key**: access to **this bucket
   only**, **Read and Write**. Copy `keyID` and `applicationKey` (shown once).

---

## 5. Render: the Blueprint

**5.1 Sign up.** render.com → **Get Started** → **GitHub**. No card is asked
for. Allow Render access to the `task-manager` repository only.

**5.2 Create from the Blueprint.** **New +** → **Blueprint** → choose
`task-manager` → **Blueprint Name** `taskmanager`, branch `main`. Render
reads `render.yaml` and shows one **free web service**, `taskmanager`, in
Singapore, and asks for every `sync: false` value:

| Key | Value |
| --- | --- |
| `WEB_ORIGIN` | `https://taskmanager.onrender.com` (corrected in 5.4 if Render picks another name) |
| `DATABASE_URL` | the Session pooler URI from 2.2, ending `/postgres` |
| `DATABASE_CA_CERT` | the whole certificate from 2.3: open the `.crt` file in Notepad, copy everything from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`, and paste it, line breaks and all |
| `BREVO_API_KEY` | `xkeysib-...` |
| `MAIL_FROM` | `Task Manager <no-reply@example.com>` |
| `S3_ENDPOINT` | `https://<ref>.storage.supabase.co/storage/v1/s3` |
| `S3_ACCESS_KEY_ID` | from 2.5 |
| `S3_SECRET_ACCESS_KEY` | from 2.5 |

`JWT_ACCESS_SECRET` is generated by Render; everything else, the region
included, has its value in `render.yaml`. **Apply**.

**5.3 Watch the first deploy.** **Dashboard → taskmanager → Logs**. The build
takes several minutes on the free builder. Then, in order:

```
Migrations applied.
API listening.          {"mode":"all"}
Schedules registered.
Job worker listening.
```

The service turns **Live** once `/api/v1/ready` answers 200. If it stops at
`Refusing to start in production:` instead, the lines after it name every
setting that is wrong. A certificate problem shows as `Migration failed` with
`self-signed certificate in certificate chain` (the wrong CA in
`DATABASE_CA_CERT`) or `does not match` (a host name other than the pooler's).

**5.4 Correct `WEB_ORIGIN` if needed.** The URL is at the top of the service
page. If it is not `https://taskmanager.onrender.com`: **Environment** →
`WEB_ORIGIN` → **Edit** → the real URL → **Save, rebuild, and deploy**. Links
in emails are built from it.

A custom domain is optional: **Settings → Custom Domains → Add**, the CNAME
Render shows at your DNS provider, then set `WEB_ORIGIN` to it.

**5.5 Let Render's addresses call Brevo.** Brevo blocks API calls from
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

**5.6 Updates.** Every push to `main` deploys, migrations first. To go back:
**Events** → an earlier deploy → **Rollback**. Migrations are additive, so an
older release runs against a newer schema.

---

## 6. UptimeRobot: monitor and keep-awake

uptimerobot.com → sign up → **+ New monitor**:

- **Monitor Type:** Keyword.
- **URL:** `https://taskmanager.onrender.com/api/v1/ready`
- **Keyword:** `"ready":true`, alert when it **does not exist**.
- **Monitoring Interval:** 5 minutes.
- **Alert contacts:** your email.
- **Create Monitor**.

Every 5 minutes is what keeps Render from sleeping (15 minutes) and Supabase
from pausing (7 days). It is also the alert when either is down: `/ready`
returns 503 when the database or the job queue is unreachable.

---

## 7. The first administrator, from your machine

Render's free tier has no Shell, so the account is created from this
repository on your Windows machine, against the Supabase database. The CLI
prompts for the password and stores only its hash; it sends no email.

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

## 8. Organisation settings, holidays and a test email

Sign in at `https://taskmanager.onrender.com`. "Settings" is the **More**
menu (the gear). Do this before inviting anybody: every business date is
computed from these, and changing them later moves dates on existing work.

1. **Settings → Organisation:** time zone `Asia/Kolkata`; weekend Saturday
   and Sunday; working hours `8`; daily digest `09:00`; week starts Monday.
   **Save**.
2. **Settings → Holidays:** this year's public holidays.
3. **Settings → Email → Send a test email**, to an address at another
   provider. In the received message's headers (Gmail: ⋮ → **Show
   original**): `spf=pass`, `dkim=pass`, `dmarc=pass`. If nothing arrives,
   Render's **Logs** show Brevo's reason (see 5.5).
4. **The smoke team**, as in
   [`deploy.md`, **The smoke team**](deploy.md#7-the-smoke-team): team
   `Smoke` with **Internal team** ticked, project `Smoke` with key `SMOKE`,
   and `smoke@example.com` invited as its Team Lead. Set its password from
   the invitation.
5. Upload a file to any task and download it again: that is Supabase
   Storage working.

Then invite the team.

---

## 9. Smoke test, from Windows PowerShell

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

## 10. The first backup, and a restore drill

**10.1 The secrets.** GitHub → the repository → **Settings → Secrets and
variables → Actions → New repository secret**, one each:

| Secret | Value |
| --- | --- |
| `DATABASE_URL` | the Session pooler URI from 2.2, as on Render |
| `DATABASE_CA_CERT` | the certificate text from 2.3, as on Render. The backup connects with `sslmode=verify-full` against it |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | as on Render; bucket `task-attachments` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | as on Render |
| `BACKUP_S3_ENDPOINT` | `https://s3.<region>.backblazeb2.com` |
| `BACKUP_S3_REGION` | `<region>` |
| `BACKUP_S3_BUCKET` | the B2 bucket |
| `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` | the B2 `keyID`, `applicationKey` |

**10.2 The first backup.** **Actions → Backup → Run workflow → Run
workflow**. It takes two or three minutes: it builds the backup image with
`pg_dump` 17, dumps the app's schemas (`public`, `pgboss`, `drizzle`, not
Supabase's own) through the Session pooler, copies the Storage bucket, and
prunes dumps older than 14 days. The log ends `Backup complete`; the B2 bucket
now has `database/taskmanager-<stamp>.dump` and `files/`.

After this it runs every night at 02:30 India time (21:00 UTC). GitHub can
start a scheduled run some minutes late.

**10.3 The restore drill.** **Actions → Restore drill → Run workflow**,
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
| Emails missing | **Logs**, `Brevo refused the email (...)`: a 401 is the key or an address Brevo has not authorised (5.5); a 400 is usually an unauthenticated `MAIL_FROM` domain. |
| Uploads fail | `S3_*` values, **S3 protocol** enabled on Supabase, and the bucket name. |
| Site takes 30 seconds to open | It was asleep: check the UptimeRobot monitor is running. |
| Supabase says the project is paused | **Restore project** in the Supabase dashboard; then the monitor and the app keep it awake. |
