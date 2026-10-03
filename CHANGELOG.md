# Changelog

Notable changes, newest first. Dates are the day the work landed on `master`.

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
