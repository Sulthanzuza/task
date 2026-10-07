# Changelog

Notable changes, newest first. Dates are the day the work landed on `master`.

## v1.1.0-rc1 — 2026-10-07

Two features, and the first schema changes since launch: migrations `0005`
and `0006` both run on startup.

### Added

- **Group tasks: one piece of work given to several people, each with their
  own copy.** A parent carries the shared title, description, dates and
  priority; its children are the real tasks, one per person, each with its
  own key, activity, comments and notification.

  Two rules hold it together. The parent is **derived**: its status and
  progress are read off the children and never set by hand, recomputed inside
  the same transaction as whatever changed a child, because recomputing
  afterwards leaves a window where a group reads "3 of 8" with a fourth
  already complete. And the parent is **never counted**: all seventeen
  aggregate queries exclude it, or a group of eight would read as nine pieces
  of work and a lead's numbers would drift further from the truth the more
  the feature was used. Cancelled children leave the denominator too, so five
  of eight where one person left is five of seven rather than a group that
  can never finish.

  The create drawer takes several people and says "Each person gets their own
  task" before the button is pressed. A group's page is a People table and a
  summary line; a child links back with a "Group: ERP-200" chip; My Tasks
  shows a member their own copy only; the task list gives a group one line
  and an icon; the board hides containers behind a toggle, since a column
  holding a group and its children shows the same work nine times.

  Migration `0005_mixed_nomad`.

### Changed

- **Every attachment now says what it is for.** Uploading a file requires a
  description (1 to 500 characters), on the task page and in the create
  drawer alike. The API refuses an upload without one, the list and the
  timeline show it, and it stays on the activity row after the file is
  deleted. Files attached before this carry an empty description and show
  "No description". Migration `0006_attachment_description`.

- **`task.progress` is no longer open to the whole team on a group child.**
  Progress is a collaborative signal like a comment, which is right for an
  ordinary task and wrong for one person's share of a group, where a
  colleague moving their bar is the confusion the feature exists to prevent.
  `TaskResource.inGroup` narrows it to the assignee and a lead; ordinary
  tasks are unchanged.

### Known follow-ups

Three parts of the group-task brief are deliberately not in this tag:

- Editing a parent does not offer to cascade to the children. There is no
  "Apply to the open personal tasks too?" prompt; `updateGroupSchema` and
  `GROUP_SHARED_FIELDS` are in `packages/shared` ready for it.
- A parent's comments and attachments are not shown on its children. Each
  child has its own, which works; the "From the group task" section is
  missing.
- The digest lists children individually rather than folding a group into one
  line. The counts are right either way, since children are what count.

## v1.0.0-render-rc4 — 2026-10-06

### Added

- **A one-time bootstrap of the first administrator**, for Render's free tier,
  which has no shell. With `BOOTSTRAP_ADMIN_EMAIL` (and optionally
  `BOOTSTRAP_ADMIN_NAME`) set, a start against an **empty** users table
  creates that SUPER_ADMIN with no password and logs a single-use link to set
  one, valid 24 hours, at WARN. Only the token's hash is stored; the raw token
  is in that log line alone. With anybody in the table it does nothing and
  logs that it was skipped: it never creates a second admin or resets a
  password. The check and the insert share a transaction under an advisory
  lock, so instances starting together create one admin. Both variables are
  in `render.yaml` (`sync: false`, optional) and the guide says to remove
  them after the first sign-in.

### Verified

- Creates on an empty database (password-less SUPER_ADMIN, hash only, one WARN
  line carrying the link); the link sets a password once and signs in;
  skips when users exist, leaving every password and token untouched; skips
  on every start after the first; three concurrent bootstraps create one
  admin; an empty value counts as unset; a malformed address is refused. Real
  log output keeps the link while still redacting nested `token` fields.

## v1.0.0-render-rc3 — 2026-10-06

Launch without email and without a domain of our own: the app runs at
`https://<service>.onrender.com` and sends no email. Both can be added later
by configuration (`docs/deploy-render.md`, "Later").

### Added

- **`MAIL_TRANSPORT=none`.** Allowed in production, with a warning at every
  start instead of a refusal. Nothing is emailed and no email job is queued;
  notifications still reach the bell and the daily digest still arrives in the
  app (its notification links to the day's digest page).
- **Copyable invite links.** Inviting someone, or making a new invitation,
  hands the admin the link: single use, valid 7 days, and a new one retires
  the previous one. With email on it is emailed too, and the admin's copy is
  the same link, for when the email does not arrive.
- **Admin reset links.** **Admin → People → Reset link** issues a single-use
  link valid for 24 hours, retiring any earlier one, never emailed, recorded in
  the audit log (`user.reset_link_issued`). `POST /api/v1/users/:id/reset-link`,
  admins only, refused for deactivated accounts.
- **`GET /api/v1/auth/options`**, public: `{ email: boolean }`, so the sign-in
  pages know before anyone signs in.

### Changed

- **Forgot password** says "Ask your admin for a reset link" when email is off,
  and the endpoint creates no token there is no way to deliver (the answer is
  the same either way, so it still reveals nothing about who has an account).
- **Settings → Email** shows "Email is turned off" in place of the test email;
  the test-email endpoint says the same (409) instead of pretending to send.
  The digest preview stays: the digest is still delivered in the app.
- **`render.yaml`:** `MAIL_TRANSPORT=none`; `BREVO_API_KEY` and `MAIL_FROM`
  are no longer asked for (documented for later); `COOKIE_DOMAIN` and
  `CORS_ORIGINS` explicitly empty, for a host-only cookie on the onrender.com
  address (a public suffix, which must never be a cookie domain). Region
  Singapore, as before.
- **`docs/deploy-render.md`:** no email or DNS steps before launch; inviting
  and resetting by link; Brevo (with Render's IP ranges) and a custom domain in
  a "Later" section.
- **`pnpm e2e:all` runs the launch configuration:** `RUN_MODE=all` and
  `MAIL_TRANSPORT=none`. Tests that read a mailbox skip themselves there;
  `pnpm e2e` keeps email on. The invitation test runs in both.

### Verified

- Email off and email on side by side in integration tests: options, forgotten
  password, invite and resend links (single use, 7 days, the old one retired),
  reset links (24 hours, admins only, not for deactivated accounts, audited),
  the test email, the bell with no email job queued, and, with email on, the
  invitation email carrying the very link the admin was shown. A host-only
  session cookie with `COOKIE_DOMAIN` empty. Production starts with
  `MAIL_TRANSPORT=none` and warns.
- End to end, in both modes: inviting through the screen and signing in from
  the link; copying a reset link (read back from the clipboard) and using it
  once; the forgot-password page; Settings → Email; the digest in the bell.

## v1.0.0-render-rc2 — 2026-10-06

Decisions on the Render release: both services in Singapore, verified
database TLS, and migrations that cannot race.

### Changed

- **Database TLS is verified.** `DATABASE_CA_CERT` (PEM, from Supabase's SSL
  settings) is passed as `ssl.ca` with `rejectUnauthorized: true` to every
  pool: the app's, pg-boss's, the migrator's and the CLI's. The server's
  certificate is checked against it, host name included. Production refuses
  to start without it unless `DATABASE_TLS=off`, which the Docker deployment
  sets because its Postgres never leaves the host. A `sslmode` (or any TLS
  setting) left in `DATABASE_URL` is refused, because pg would let it
  override the certificate. The `uselibpqcompat=true&sslmode=require` form is
  gone; one plain URL now serves Render, the first admin and the backups.
- **The GitHub Actions backup and the scratch restore verify too:**
  `PGSSLMODE=verify-full` with `PGSSLROOTCERT` written from the
  `DATABASE_CA_CERT` secret (or `SCRATCH_DATABASE_CA_CERT`). They refuse to run
  without one.
- **Migrations take `pg_advisory_lock`** on one connection for their whole
  run, so two instances starting together cannot both migrate: the second
  waits, then finds nothing to do.
- **The migrator checks the production configuration before connecting.**
  It runs first in the start command, so it is what would have connected
  without a CA certificate, unencrypted, to a database that allowed it; the
  server's own check came too late.
- **Singapore for both.** The guide creates the Supabase project in
  Southeast Asia (Singapore), beside the Render service; `render.yaml` sets
  `S3_REGION=ap-southeast-1`.
- **Brevo keeps blocking unknown addresses.** The guide adds Render's
  published outbound ranges for Singapore to Brevo's Authorized IPs, after the
  service exists, instead of turning the blocking off.

### Fixed

- **Calendar day cells were buttons containing links** (axe:
  `nested-interactive`), which assistive technology cannot present as either.
  The cell is now a plain element and the day number is the button, labelled
  with the full date and carrying the selected state; a click anywhere in the
  cell still selects the day. It surfaced only on days with tasks, in runs
  where the tasks had rendered before axe looked.

### Verified

- Two migrator processes started together against an empty database: both
  succeed, each migration applied once. With the lock held elsewhere a
  migrator applies nothing until it is released. With the lock removed, the
  same test fails (`duplicate key value violates unique constraint
  "pg_extension_name_index"`), so it is the lock that passes it.
- Against Postgres servers with certificates from a CA made for the test:
  both pools connect over TLS (`pg_stat_ssl`), a certificate pasted as one
  line with `\n` works, another CA is refused, a certificate from the right CA
  for another host name is refused, and `?sslmode=` in the URL is refused.
- libpq as the backup workflow runs it: the CA written by `printf '%b'` from a
  one-line secret, `psql` and `pg_dump` with `verify-full` connect; a wrong CA
  and a wrong host name are refused.
- The Render image, production mode, against a TLS-only Postgres 17: two
  instances started together both came up (`Waited for another migrator to
  finish` in one log), each migration recorded once, every app connection on
  TLS. Without the CA, against a Postgres that accepts plain connections, the
  migrator refused and created nothing.
- Not verified: Supabase's own certificate and pooler host names. Its CA is
  documented for `verify-full`; the first real deploy is the test.

## v1.0.0-render-rc1 — 2026-10-06

A second way to deploy, free and with no credit card: one Render web service,
Supabase for the database and files, Brevo's HTTP API for mail, GitHub
Actions for backups to Backblaze B2, UptimeRobot to watch it and keep it
awake. Step by step in `docs/deploy-render.md`. The Docker deployment is
unchanged apart from one new required setting, `MAIL_TRANSPORT=smtp`.

### Added

- **`RUN_MODE=all`.** `dist/server.js` runs the HTTP server, Socket.IO and the
  pg-boss worker in one process, and serves the built web app with an SPA
  fallback, on one origin. The static files get the headers and caching
  Nginx gives them in Docker; the API's `default-src 'none'` policy is kept
  off the HTML. `dist/server.js` and `dist/worker.js` still run separately
  for Docker (`jobs/runWorker.ts` is shared). With `JOB_QUEUE_ENABLED=false`
  the in-process worker does not start, so it cannot take jobs meant for
  another process.
- **`MAIL_TRANSPORT=brevo-api`** sends through Brevo's transactional API, for
  hosts that block SMTP. Same templates; a refusal throws, so notification
  emails are retried by pg-boss as before.
- **`DATABASE_MAX_CONNECTIONS`**: one budget for the app's pool and pg-boss's
  together (3 + 2 at 5), for Supabase's Session pooler.
- **`ARGON2_MEMORY_COST`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`**, defaulting
  to OWASP's minimum (19 MiB, 2, 1), refused below it in production. A
  sign-in with a hash made at other settings replaces it.
- **`TRUST_PROXY_HOPS`**, defaulting to one in production as before.
- `render.yaml`, `docker/render.Dockerfile` (migrations, then the server),
  `.github/workflows/backup.yml` (nightly at 02:30 IST) and
  `restore-drill.yml` (into a throwaway Postgres or a scratch Supabase
  project), and `pnpm e2e:all`, the end-to-end suite against one process.

### Changed

- **Attachment downloads are streamed** from storage instead of read into
  memory first.
- Production refuses to start without `MAIL_TRANSPORT`, with the Brevo
  transport and no key, with `STORAGE_DRIVER=s3` and no keys, or with
  `RUN_MODE=all` and no built web app.
- **Backups:** `PG_DUMP_SCHEMAS` limits a dump to the app's schemas (on
  Supabase, the platform's own would not restore anywhere else); the backup
  image takes `PG_MAJOR`. **Restores** start from emptied app schemas rather
  than `pg_restore --clean`, which could not drop pg-boss's partitioned
  tables, so a second drill into the same database failed; they create the
  `citext` and `pg_trgm` extensions first; and they refuse the production
  database by identity even when a scratch target is opted in by name.
- Development: MinIO is gone from `docker-compose.yml` (its image no longer
  exists); attachments are stored on disk. `.gitignore` covers every `.env*`
  file except the two templates, and `certs/` and `certbot-www/`.

### Fixed

- **Scheduled queues were polled before they existed** on a fresh database,
  logging an error per queue on the first boot. `registerSchedules` now runs
  before the scheduled workers start.
- **Reloading quickly could sign a person out everywhere.** A reload aborts
  the page's refresh after the server has rotated the token, and a refresh
  queued behind it can do the same, so the browser comes back holding a token
  two rotations old. Reuse detection took that for theft and revoked every
  session. A replay inside the grace window now moves that token's successor
  pointer to the session it produced, so repeated replays of one token are
  recognised as one browser losing responses. Presenting a *successor* still
  moves the chain on and is still treated as theft, and the window is still
  measured from the original rotation. Found by the `RUN_MODE=all` suite,
  where the faster single process lets the aborted requests land.
- **Out-of-month days on the calendar failed contrast** (2.4 to 2.7:1 in all
  four themes): the cell was faded with `opacity-60`, which no text colour
  inside it could survive. The fade is gone; the day number is set back from
  ink to muted instead. Exposed by the calendar fix in `e48beb7`, which made the page
  render for people it had been stuck loading for.

### Verified

Typecheck, lint, unit and integration tests, the end-to-end suite, and the
same suite against `RUN_MODE=all`. A rehearsal of the Render deployment with
stand-ins: the Render image at 512 MB and 0.1 CPU behind PgBouncer in session
mode (as Supabase's pooler) on Postgres 17, an S3 server, and a Brevo stub.
Ready in 28 seconds, idle at about 50 MB, exactly 5 database connections;
the first admin created from outside, sign-in, an invitation and a pg-boss
notification email through the Brevo stub, an attachment stored and
streamed back byte for byte, a restart re-running migrations harmlessly; a
backup with `PG_DUMP_SCHEMAS`, and restores into a fresh Postgres 17 and an
opted-in scratch database, each twice, with the production database refused.

## v1.0.0-rc4 — 2026-10-06

The runbook rewritten for Oracle Cloud Always Free (Ampere A1, arm64), and
two bugs that would have stopped any fresh deployment.

### Fixed

- **MinIO could no longer be installed.** Its server image is gone from
  Docker Hub and its `mc` client downloads return 410, so a fresh server could
  not start the stack or build the backup image, on any architecture. The
  `minio` service is removed: attachments live in OCI Object Storage through
  its S3 API, and the backup and restore scripts use rclone from the Alpine
  archive (`scripts/rclone-remotes.sh` defines both remotes from the
  environment, so no file holds the keys).
- **The scripts were not executable.** They were committed as `100644`, so
  `./scripts/check-tls.sh`, `exec backup /scripts/backup.sh` and
  `/scripts/restore.sh` would all have failed with "Permission denied" on the
  server.
- **No `.dockerignore`.** A build from a developer's checkout copied its
  `node_modules` over the image's own, and the build context carried `.git`,
  `backups/` and any `.env` file.
- **The backup no longer creates its bucket.** It checks the bucket is
  reachable and fails loudly if not; the key is scoped to one bucket and
  cannot create one anyway.

### Changed

- `docs/deploy.md`: a new **Oracle Cloud: the server** section (instance, VCN
  security list, iptables rather than ufw, idle reclamation, the attachments
  bucket); Brevo SMTP with its SPF, DKIM and DMARC records; Backblaze B2 with
  a one-bucket key and the lifecycle rule that makes deletions free space;
  UptimeRobot; and **The whole sequence**, every command in order.
- `.env.production.example`: Brevo, OCI Object Storage and B2 values, and
  `AWS_*_CHECKSUM_*=WHEN_REQUIRED` for S3-compatible stores.

### Verified

All three images built with `docker buildx build --platform linux/arm64`;
argon2 hashes and verifies in the arm64 API image; nginx and the built app
are in the arm64 web image. In the arm64 backup image, against a throwaway
Postgres and an S3 server: backup, attachment copy, remote retention (an aged
dump removed, recent ones kept), a wrong key failing loudly, restore from the
remote copy (50 users, 200 tasks verified), and the guard refusing the live
database name.

## v1.0.0-rc3 — 2026-10-03

Review of the rc2 runbook, which found one real bug and several commands
that would not have worked as written.

### Fixed

- **The placeholder certificate was written into certbot's own directory.**
  `/etc/letsencrypt/live/<domain>/` belongs to certbot; finding it already
  populated, certbot issues to `<domain>-0001` and leaves the original
  alone, so nginx would have gone on serving a self-signed certificate
  forever with the site up and untrusted and nothing in any log. The
  placeholder now lives in `/etc/nginx/placeholder/` and nginx reads
  `/etc/nginx/tls`, a symlink that the entrypoint points at the real
  certificate as soon as one exists. `scripts/check-tls.sh` checks for a
  `-0001` sibling and reads the issuer off the wire with `openssl s_client`,
  because this failure is invisible from the server side.
- **The env check needed Node on the server.** It ships in the API image now
  and runs as `docker compose run --rm --no-deps api node dist/cli/envCheck.js`.
  With no file to read it validates the environment Compose handed it, which
  is the same thing the API will see a second later.
- **`exec backup mc ls backup/$BACKUP_S3_BUCKET/...`** expanded the variable
  in the host's shell, where it is empty, so it listed the wrong path and
  printed nothing — indistinguishable from a backup that is not running.
- **The restore drill put the database password in shell history**, in `ps`
  output and in the Compose logs. The URL is assembled inside the container
  now, from variables it already holds, and the scratch database is dropped
  afterwards.

### Added

- A 2GB swap file and `unattended-upgrades` in the server preparation, and a
  warning that **Docker bypasses ufw** for published ports: only nginx may
  ever publish one.
- Organisation settings and holidays as an explicit step, before anybody is
  invited. Every business date in the product is computed from them, and
  changing them later silently moves dates on work that already exists.
- The PowerShell form of the smoke-test command, since PowerShell has no
  inline `VAR=value command` and the bash line silently sets nothing there.
- `certbot renew` gained a `--deploy-hook` that records the time of the last
  renewal, and the nginx reload loop runs every six hours against a certbot
  that renews twice a day.

### Changed

- The first administrator's password is set at a prompt by the CLI, which
  sends no email. The runbook now says so, and puts the SPF/DKIM test email
  before the first *invitation* rather than before the admin, which was
  where it actually mattered.

## v1.0.0-rc2 — 2026-10-03

A first-deploy runbook that someone can actually follow, and the code changes
it turned out to need.

### Added

- **`pnpm env:check`** validates `.env.production` with the same Zod schema
  and the same production rules the API applies at boot, without starting
  anything. Finding out that a secret is sixteen bytes by watching a
  container crash-loop is a poor way to learn it.
- **An internal flag on a team** (`teams.is_internal`, a checkbox in
  Settings → Teams). An internal team is ordinary for every permission
  question and is left out of the dashboard pickers, the daily digest and the
  overdue alerts, so the deploy pipeline's smoke traffic cannot move the
  numbers a lead reads or page anybody about a task that existed for ninety
  seconds. Three integration tests cover the exclusions.
- **Automatic TLS.** certbot issues and renews in webroot mode, so nginx
  keeps serving throughout; `--standalone` wants port 80 to itself, which
  means taking the site down to renew. nginx writes itself a short-lived
  self-signed placeholder on the first boot, which is what breaks the
  deadlock between "nginx will not start without a certificate" and "certbot
  cannot get one without nginx".
- **Docker log rotation** on every service, 10MB x 3. The default is to keep
  container logs forever, which is the usual way a small server fills its
  disk.

### Changed

- **Backups go off the server.** The nightly job copies the dump *and* the
  attachments bucket to a separate S3-compatible provider, with 14-day
  retention there and 3 days locally. The restore drill pulls from the remote
  copy: restoring the file still sitting on the server proves the dump is
  readable and nothing about whether the backup that matters arrived
  anywhere. The job runs from its own image, because the stock postgres image
  has no way to reach a bucket — the previous off-site line invoked an `aws`
  binary that was never installed.
- **The smoke test writes and cleans up.** It creates a task in the internal
  Smoke project, moves it through the workflow and deletes it. A read-only
  check cannot tell a working deployment from one whose database is mounted
  read-only.
- **Rollback is a documented policy**, not a named tag: every release is
  tagged, rollback is a checkout of the previous release tag, and the first
  deploy has no rollback at all. Every deploy now takes a backup before the
  migrations run.
- **nginx is a template.** The certificate paths carry the domain, so
  `SERVER_NAME` comes from the environment rather than being baked into the
  image.

### Documentation

`docs/deploy.md` gains a "Before you start" section (Ubuntu 24.04, a non-root
sudo user, Docker Engine, ufw, a DNS check with `dig`), a table of every
variable `.env.production` needs with how to generate each one and what
rejects it, a numbered first-deploy order that reaches HTTPS before the first
administrator is created, and an external uptime check on `/api/v1/ready`
rather than `/health`, which answers 200 through a dead job queue.

## v1.0.0-rc1 — 2026-10-01

Everything since `v0.1-core`, which was the API, the data model and the first
screens. This is the first build intended to be deployed.

### Added

**Collaboration and workflow**

- Real-time board and calendar over Socket.IO, with rooms decided by the
  server so a client cannot subscribe to a team it is not on.
- Notifications: in-app bell and email, per-type preferences including
  digest-only, quiet hours in each person's own time zone, and one email per
  burst rather than one per event.
- Scheduled alerts, escalations and a daily digest, all leave-aware and
  idempotent through `alert_log` and `digest_log`.
- Comments with `@[Name](id)` mentions and a mention autocomplete; attachments
  typed by magic bytes rather than by what the client claimed.
- Administration: people, teams, projects, organisation settings, holidays,
  email configuration, CSV import and an audit trail.

**Interface**

- A design system in four themes (`midnight`, `dusk`, `light`, `violet`),
  defined as tokens in `apps/web/src/index.css` and visible at `/design`.
- A rebuilt dashboard: KPI pills, hero, throughput, work mix, project
  progress, status and priority mixes, an attention list, a team table and a
  due-load heat map.
- Every other screen moved onto the same tokens, including a per-role review
  screenshot set.
- `pnpm db:seed --demo`: twelve weeks of deterministic history, dated relative
  to now, so the charts have something in them. Refuses to run in production.

**API**

- `GET /org/calendar` — weekend days and holidays for anybody signed in, so a
  calendar can draw a week correctly. `/org/settings` stays behind
  `org.manage`.
- `workingDaysBlocked` on a task summary, counted on the server against the
  organisation's calendar, as `workingDaysLate` already was.
- `actorName` on a notification, which was stored but never returned.

**Operations**

- Production hardening and deployment: helmet CSP, fail-fast configuration,
  health and readiness endpoints, nightly backup with a verified restore
  drill, and a `create-user` CLI for the first administrator.
- Plus Jakarta Sans is served from the image. The application fetches nothing
  from a third party at runtime.

### Fixed

The ones that were hiding something rather than merely looking wrong:

- **Primary buttons in `dusk` and `light` were white on a bright cyan
  gradient: 1.81:1.** Neither theme restated `--color-accent-from/to`, so both
  inherited `midnight`'s. axe had scanned those screens and passed them,
  because it cannot measure text against a `background-image` at all.
- **Every status and priority badge was under 4.5:1 in at least one theme.**
  The pill was tinted with 14–18% of its own colour, which pulls the
  background towards the text; the tokens cleared the floor against a plain
  card, not against the pill they are drawn in. 25 tokens were re-tuned.
- **A sticky table header positioned itself against its own card.** Any
  ancestor with a clipped or scrolling overflow is a scrollport, and a sticky
  child measures `top` from the nearest one, so the header floated over the
  second row with a gap above the first.
- **Relative times read as the future** ("in 4 hours" on an hour-old comment),
  because the server's clock and the browser's are two different clocks.
- **The timeline printed database values at people**: "Sulthan
  attachment.created".
- **Board cards carried dnd-kit's `role="button"` over a link**, so nothing
  inside them could be reached by keyboard.
- `FormData` was JSON-stringified before being sent, so no upload could ever
  have worked; `attachment.created` was declared but never emitted, so a
  second tab never saw a file arrive; task search could not match a task key;
  and a lead could preview an import but never commit it.

### Changed

- Tables share one `DataTable` with fixed column widths, so a key column is
  the same width on every screen and a long title truncates instead of pushing
  the dates out of view.
- Dates go through one formatter, which shows the year only when it is not
  this one and counts lateness in working days.
- Colour comes from one map in `packages/shared/src/colors.ts`. A unit test
  fails the build on a hex literal anywhere in `apps/web/src` outside the
  palette files.

### Testing

- `apps/web/src/__tests__/tokens.test.ts` reads the stylesheet and checks
  contrast in all four themes: text at 4.5:1, badges against their own tint,
  chart marks at 3:1 as graphical objects, the heat-map ramp at five points,
  the hero's colours against the hero's background, and CIE76 dE >= 22 between
  the seven open statuses.
- `apps/web/e2e/tests/accessibility.spec.ts` runs axe over ten screens in four
  themes, over login, and over the states a screenshot never catches: the
  notification dropdown, the create drawer, a confirm dialog and a transition
  dialog. A fourth test fails any control under 44px at 375px.
- Counts at this tag: 23 shared unit, 50 web unit, 376 API integration against
  a real Postgres, 58 end-to-end.

### Known limitations

- One API instance only. Socket.IO holds connection state in memory, so a
  second instance silently stops delivering events to half the users.
- Prompts 14–19 (workload with leave, checklists, recurring tasks, check-ins,
  saved views and bulk actions, integrations) are not built. The dashboard's
  team table has no load column for that reason.
- Migrations are additive and do not roll back. A release containing a
  destructive migration cannot be rolled back by checkout; say so in its notes.

## v0.1-core

The API, the data model, authentication, permissions, the workflow engine and
the first screens. Not deployable on its own.
