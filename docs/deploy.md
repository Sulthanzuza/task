# Deploying Team Task Manager

Written for whoever runs this on a server, including the version of you that
has forgotten how it works.

One VPS is enough for a team of eight to thirty. The stack is Nginx, one API,
one worker, Postgres, MinIO, a backup job and a watchdog, all from
`docker-compose.prod.yml`.

---

## Before the first deploy

1. A domain pointing at the server, and port 80 and 443 open.
2. Docker and the Compose plugin installed.
3. An SMTP provider with **SPF and DKIM** set up (see below). Without them,
   invitations and alerts land in spam, and the product looks broken on day one.

---

## First deploy

```bash
git clone <repo> /srv/taskmanager && cd /srv/taskmanager
cp .env.production.example .env.production

# Generate real secrets. The API refuses to start with the example values.
openssl rand -hex 32   # JWT_ACCESS_SECRET
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 24   # S3_SECRET_ACCESS_KEY

$EDITOR .env.production

docker compose -f docker-compose.prod.yml up -d --build
```

The `migrate` service runs to completion before the API starts, so the schema
is always applied before anything serves.

### The first administrator

Every account is invited from the UI, which needs somebody signed in to do the
inviting. The first one is made on the server:

```bash
docker compose -f docker-compose.prod.yml run --rm api \
  node dist/cli/createUser.js --email you@example.com --name "Your Name" --role SUPER_ADMIN
```

There is deliberately no unauthenticated "create the first admin" page: that is
a race with whoever finds the deployment first. Everyone else is invited from
**Settings → People**, which emails them a link to set their own password.

### TLS

```bash
docker run --rm -p 80:80 -v /srv/taskmanager/certs:/etc/letsencrypt \
  certbot/certbot certonly --standalone -d tasks.example.com
```

Then uncomment the `listen 443` block in `docker/nginx.conf` and the `443` port
in `docker-compose.prod.yml`, and `docker compose up -d web`.

Renewal, monthly, from the host crontab:

```
0 3 1 * * cd /srv/taskmanager && docker run --rm -v /srv/taskmanager/certs:/etc/letsencrypt certbot/certbot renew --quiet && docker compose -f docker-compose.prod.yml restart web
```

---

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
| `worker` | `GET :4001/health` | Worker process alive |
| `web` | `GET /healthz` | Nginx serving |
| `postgres` | `pg_isready` | Accepting connections |

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

The `backup` service takes a compressed `pg_dump` at start-up and then daily,
into `./backups`, keeping fourteen days. Set `S3_BACKUP_BUCKET` to also copy
off-site; a backup on the same disk as the database protects against very
little.

```bash
# On demand
docker compose -f docker-compose.prod.yml exec backup sh /scripts/backup.sh

# What is there
ls -lh backups/
```

### Restoring

`scripts/restore.sh` refuses any target database whose name does not end in
`_restore`, `_scratch` or `_verify`. The point of practising a restore is not to
destroy the thing you are protecting.

```bash
docker compose -f docker-compose.prod.yml exec postgres \
  psql -U taskmanager -d postgres -c "CREATE DATABASE taskmanager_restore;"

docker compose -f docker-compose.prod.yml exec backup \
  sh /scripts/restore.sh /backups/<file>.dump \
  "postgres://taskmanager:<password>@postgres:5432/taskmanager_restore"
```

It counts the users and tasks it restored and fails if there are none, so
"finished without error" cannot be mistaken for "worked".

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

- [x] Nightly backup has run at least once, and the file is a plausible size.
- [x] A restore into a scratch database has succeeded and been verified.
- [ ] SPF and DKIM pass on a test email.
- [ ] TLS certificate installed and renewal scheduled.
- [ ] The first administrator created, and a second admin account exists so one
      lost password is not a lockout.
- [ ] Smoke tests pass against the live URL (below).

---

## Deploying an update

GitHub Actions builds and deploys on a tag. By hand:

```bash
cd /srv/taskmanager
git fetch --tags && git checkout <tag>
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f --tail=50 api worker
```

Migrations run automatically, before the API starts.

### Smoke test after deploying

```bash
BASE_URL=https://tasks.example.com \
SMOKE_EMAIL=smoke@example.com \
SMOKE_PASSWORD=<password> \
pnpm smoke
```

Use a **dedicated account** with ordinary member rights, not an administrator
and not a real person's login. Create it from Settings like any other invite.

### Rolling back

Images are tagged with the release, so a rollback is a checkout and a rebuild:

```bash
git checkout <previous-tag>
docker compose -f docker-compose.prod.yml up -d --build
```

**Migrations do not roll back.** Drizzle migrations here are additive, so an
older application runs against a newer schema; if a release ever adds a
destructive migration, that release cannot be rolled back this way, and the
path is restore-from-backup. Say so in the release notes when it happens.

---

## Observability

Logs are JSON on stdout in production:

```bash
docker compose -f docker-compose.prod.yml logs -f api worker
```

`LOG_LEVEL` controls verbosity. Authorization headers, cookies and anything
that looks like a password or token are redacted by the logger.

Worth watching:

- `Unsafe setting for production` — a relaxed test setting reached the server.
- `A revoked refresh token was replayed` — possible stolen session cookie.
- `Could not send a notification email` — SMTP trouble, before users report it.
