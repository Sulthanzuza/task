# Status

Where the build has got to. Read this first; update it when you finish a prompt.

Last updated: 2026-10-06. Branch `main`, pushed to the private `github.com/Sulthanzuza/task`, tagged **v1.0.0-render-rc4**.

Release notes are in `CHANGELOG.md`; the server runbook is `docs/deploy.md`.

## Built, by prompt

Prompts come from `Team Task Management System — Build Plan & Prompts.docx` in the repo root.

| # | Prompt | State | Where |
|---|--------|-------|-------|
| 1 | CLAUDE.md | Done — project rules, 15 of them; rule 15 defines DONE as API + UI + test | `CLAUDE.md` |
| 2 | Scaffold the monorepo | Done — pnpm workspaces (`apps/api`, `apps/web`, `packages/shared`), Docker Compose (Postgres 5433, Mailpit 1025/8025; MinIO until rc5), ESLint, Prettier, CI | `pnpm-workspace.yaml`, `docker-compose.yml`, `.github/` |
| 3 | Database schema, migrations, seed | Done — Drizzle schema split by domain, generated migrations, idempotent seed of 7 users / 2 teams / 3 projects / 20 tasks | `apps/api/src/db/` |
| 4 | Authentication | Done — login, refresh with rotation and reuse detection, logout, set/reset password, rate limits, cross-tab refresh via `navigator.locks` | `apps/api/src/modules/auth/`, `apps/web/src/lib/api.ts` |
| 5 | Permissions, teams, projects | Done — one `authorize(actor, action, resource)` matrix; teams and members; projects with immutable keys and archive; labels | `apps/api/src/modules/permissions/authorize.ts`, `modules/teams/`, `modules/projects/` |
| 6 | Tasks API, workflow, activity log | Done — CRUD, shared workflow transition table, transitions, assign with handover, progress, dependencies with cycle refusal, watchers, soft delete; every mutation writes activity in the same transaction | `packages/shared/src/workflow.ts`, `apps/api/src/modules/tasks/` |
| 7 | Comments, mentions, watchers, attachments | Done — comments with `@[Name](userId)` mentions, watcher rules, attachments typed by magic bytes rather than by what the client claimed, and each one carrying a required description of what it is for (2026-10-07) | `apps/api/src/modules/comments/`, `modules/attachments/`, `lib/fileType.ts` |
| 8 | Frontend shell | Done — React Router, sidebar layout, light and dark themes, auth context, TanStack Query client, error boundary | `apps/web/src/app/` |
| 9 | Task list, task detail, My Tasks | Done — filtered list with cursor paging, detail with timeline and transitions, My Tasks grouped by when work is due | `apps/web/src/features/tasks/` |
| 10 | Team Lead dashboard and member page | Done — KPI cards that open the list filtered to match, attention list, member stats and recent activity | `apps/web/src/features/dashboard/`, `features/team/` |
| 11 | Kanban board and calendar, live updates | Done — dnd-kit board with server-counted columns, month and week calendar in org time, Socket.IO with server-decided rooms | `apps/web/src/features/board/`, `features/calendar/`, `apps/api/src/realtime/gateway.ts` |
| 12 | Notifications | Done — in-app bell, per-type preferences including digest-only, email through pg-boss collapsed to one per burst, quiet hours in each person's own zone | `apps/api/src/modules/notifications/`, `apps/api/src/jobs/` |
| 13 | Alerts, daily digest, escalations | Done — scheduled jobs on working-hours thresholds, leave-aware, idempotent through `alert_log` and `digest_log`, digest rendered to email and to `/digest/:date` | `apps/api/src/modules/alerts/` |
| 14–19 | Workload, checklists, recurring, check-ins, search, integrations | Not started | — |
| 20–21 | Tests and security hardening, production deployment | Partly done — see below | `docs/deploy.md` |
| 22 | V2 AI layer | Not started, and deliberately: it wants months of real data first | — |

### Work done outside the numbered prompts

| Commit | What |
|--------|------|
| `b2110ac` | Pinned web port, same-origin Vite proxy, env-driven CORS |
| `36c1d12` | First real browser run: Playwright smoke tests and the bugs they found |
| `40b3449` | Cross-tab refresh race, shared task predicates, e2e in CI |
| `b35b5c2` | Production hardening and deployment: helmet CSP, fail-fast config, health checks, backup and verified restore, create-user CLI (parts of prompts 20 and 21; the 50k-task performance work is deliberately skipped) |
| `682ac5f` | Digest content and links, pre-commit hook, the tests that were missing |
| `37cdeae` | Admin area: people, teams, projects, organisation settings, holidays, email, import, audit |
| `3e968ae` | Task screens: attachments, mention autocomplete, full create drawer, optimistic updates |
| _this one_ | Attachment descriptions (2026-10-07): every upload must say what the file is for. `task_attachments.description` (migration `0006`, older rows backfilled with an empty string), required by `uploadAttachmentBodySchema` in `packages/shared`, returned by the list and create endpoints, kept on both `attachment.created` and `attachment.deleted` activity rows so the reason outlives the file. The task page holds a chosen file in a small form until it is described; the create drawer asks per queued file and refuses to create until each has one. Timeline reads "attached spec.pdf: the signed-off spec". Five new integration tests, one wording test, and the task-screens e2e updated |
| `696e511` | Design system: four themes as tokens, the top-bar shell, `/design` |
| `30ad223` | Responsive top bar: pill icons down to 900px, identity into the account menu |
| `a5313f0` | Dashboard redesign, the chart set, and `pnpm db:seed --demo` |
| `5269072` | The design system applied to every remaining screen (below) |
| `a23a195` | The fixes from the first screenshot review (below) |
| `2c6ec0c` | The second review round (below) |
| `e04853f` | The third review round, and the font (below) |
| `eefb658` | Release prep: the last three fixes, CHANGELOG.md, v1.0.0-rc1 |
| `c84f2fc` | First-deploy runbook fixes, v1.0.0-rc2 |
| `543670c` | rc3: the placeholder-certificate bug, and runbook corrections |
| `e48beb7` | Calendar takes today from `/org/calendar` (it hung for members and the admin); dashboard team picker for the admin; the More menu was clipped by the scrolling nav; Team page shows load errors |
| `4d8e19c` | rc4: Oracle Cloud Always Free runbook (arm64); MinIO removed for OCI Object Storage, backups on rclone to B2; scripts made executable; `.dockerignore` |
| `a75f1f3` | render-rc1: free deployment on Render + Supabase. `RUN_MODE=all` (one process serving app, API, sockets and jobs), Brevo HTTP mailer, connection budget, configurable argon2 with rehash on sign-in, streamed downloads, `render.yaml`, backup and restore-drill workflows, `docs/deploy-render.md`. Also: dev Compose without MinIO, stricter `.gitignore` |
| `ee25ca8` | render-rc2: Singapore for Render and Supabase; database TLS verified against `DATABASE_CA_CERT` (app, pg-boss, CLI, and the Actions backup with `verify-full`); migrations under an advisory lock; Brevo allows Render's Singapore ranges instead of blocking being turned off |
| `dbe2c44` | render-rc3: launch without email or a domain. `MAIL_TRANSPORT=none` (a warning, not a refusal); copyable invite links (single use, 7 days) and admin reset links (single use, 24 hours) in Admin → People; forgot-password and Settings → Email say email is off; `render.yaml` on the onrender address with a host-only cookie; Brevo and the custom domain moved to "Later" in the guide; `pnpm e2e:all` now runs the launch configuration |
| _this one_ | render-rc4: one-time bootstrap of the first administrator from `BOOTSTRAP_ADMIN_EMAIL` on an empty database, with a single-use set-password link in the log |

### The design system, applied (three design prompts)

These came as their own prompts, separate from the build plan above.

1. **Tokens and shell.** Four themes (`midnight`, `dusk`, `light`, `violet`) defined in
   `apps/web/src/index.css`, the top bar, and `/design` as a live sheet of every token
   and component.
2. **Dashboard.** Four rows on a twelve-column grid: KPI pills, hero, throughput, work
   mix, projects, status and priority mixes, the attention list, the team table and the
   due-load heat map. Charts in `apps/web/src/components/charts/index.tsx`.
3. **Everything else.** My Tasks, the task list, task detail, board, calendar, team and
   member, notifications and its preferences, login and reset, and all eight admin
   screens. Colour comes only from `packages/shared/src/colors.ts`; lists share
   `apps/web/src/components/common/table.tsx`; dates share `formatDate` and
   `formatDateTime` in `apps/web/src/lib/utils.ts`.

Two guards were added with the third, because both problems it fixed were invisible
until measured:

- `apps/web/src/__tests__/tokens.test.ts` reads `index.css` and fails on a hex literal
  anywhere in `apps/web/src` outside the palette files, then checks every theme for
  contrast: 4.5:1 for text, 4.5:1 for a badge **against its own tint** rather than
  against the bare card, 4.5:1 for the heat-map ink at five points along the ramp,
  3:1 for a chart mark as a graphical object, and CIE76 dE >= 22 between the seven open
  statuses so the donut can be read.
- `apps/web/e2e/tests/accessibility.spec.ts` runs axe in all four themes over ten
  screens, over login, and over the states a screenshot never catches: the notification
  dropdown, the create drawer, a confirm dialog and a transition dialog. A fourth test
  fails any control under 44px at 375px.

What those two found, all fixed in the app rather than in the test:

- Every status and priority badge was under 4.5:1 in at least one theme. The tint was
  18% of the badge's own colour, which pulls the background towards the text; the
  tokens cleared the floor against a plain card and not against the pill they are
  actually drawn in. The tint is now `PILL_TINT` (14%) and 25 tokens were re-tuned
  against the real background.
- A label chip took its text colour from the database, so any colour somebody picked in
  the label editor could be unreadable. The hue is now a dot and a border; the text is
  the theme's ink.
- The heat map switched its text colour at an intensity of 0.55, and the cells near the
  switch were unreadable either way. The ramp now ends at `--color-heat-max`, the
  darkest shade the ink still clears, so one text colour serves the whole scale.
- The unread badge on the bell was white on `--color-danger`, which is a light red in
  the dark themes.
- Board cards carried dnd-kit's `role="button"` over a link, so nothing inside them
  could be reached by keyboard. Pointer drag stays on the whole card; keyboard drag
  moved to a grip button.
- The progress ring on task detail announced the same value as the slider beside it,
  under the same name. The ring is now unlabelled where a control already carries it.
- `aria-expanded` on the mention textarea is not allowed on a textbox; the open state
  moved to a live region.
- The logo link had no accessible name below 1366, where the wordmark is hidden.

### rc3: reviewing the runbook

One real bug, found by asking where the placeholder certificate was written.

**It was written into `/etc/letsencrypt/live/<domain>/`, which certbot owns.**
Certbot finding that directory already populated issues to `<domain>-0001`
and leaves the original in place, so nginx would have served the self-signed
placeholder indefinitely: site up, certificate untrusted, nothing in any log.
The placeholder moved to `/etc/nginx/placeholder/`, nginx reads a symlink at
`/etc/nginx/tls`, and `scripts/check-tls.sh` looks for the `-0001` sibling
and reads the issuer off the wire, because nothing on the server can see this
go wrong.

Three commands in the runbook also could not have worked: the env check
needed Node on a server that has none (it is in the API image now), an
`mc ls` expanded `$BACKUP_S3_BUCKET` in the host shell where it is empty, and
the restore drill put the database password into shell history.

### The deploy runbook

Going through `docs/deploy.md` against the code found more than documentation
drift. What the runbook needed the product to grow:

- **`pnpm env:check`**, so a bad `.env.production` is caught before the first
  `docker compose up` rather than by a crash-loop.
- **`teams.is_internal`**, so the smoke test can write without its traffic
  reaching the dashboard, the digest or the alerts. The alternative was a
  read-only smoke test, which cannot tell a working deployment from one whose
  database is mounted read-only.
- **TLS that issues itself.** The deadlock is that nginx will not start
  without a certificate and certbot cannot get one without nginx; a
  short-lived self-signed placeholder written by the entrypoint breaks it,
  and webroot mode keeps the site up through every renewal afterwards.
- **A backup image.** The off-site copy in the old script shelled out to an
  `aws` binary that the postgres image does not contain, so `set -eu` meant
  the whole backup reported failure the moment a bucket was configured. It
  had therefore never worked. The job now runs from its own image with `mc`,
  copies the attachments as well as the dump, and the restore drill pulls
  from the remote copy.

### Release prep

Three last fixes, then the tag.

- **Due dates are counted in working days, not calendar days.** Nudging a
  weekend date onto the next working day piled the work up: with a Thursday
  today, a holiday on the Friday and the weekend after it, every offset from
  one to three landed on the same Monday, and the heat map showed one person
  with 46 hours due on it and nothing either side. `addWorkingDays` counts in
  working days, so nothing can land on a day nobody works and the spacing is
  even however the holidays fall. Measured after the change: 0 weekend or
  holiday due dates out of 188, and the busiest person-day down to 36 hours
  and spread across the window. The ordinary seed nudges in the same
  direction as its offset, so a task seeded three days overdue stays overdue.
- **The priority control clipped "Low".** Four labelled segments do not fit
  half of a two-column drawer. It spans the full width now and wraps to two
  rows below 420px; `task-screens.spec.ts` measures each segment's text
  against its box at 1280 and 375.
- **My Tasks titles were still clipped mid-letter.** `line-clamp-none` left
  the span a block with `overflow: visible`, which escaped the link's clip
  entirely, and `text-overflow` cannot reach into a block child. The clamp is
  `max-md:` now, so above that breakpoint the span is a plain inline and the
  link's `truncate` does what it says.

### The second review round

Thirteen more items. The ones that were covering something up:

- **Relative times read as the future.** "in 4 hours" on a comment posted an hour ago.
  Two separate causes, both fixed. In the app, `relativeTime` never phrases a past event
  as the future: anything up to five minutes ahead of the browser is "just now", because
  the server's clock and the browser's are two different clocks and a device running
  slow is enough on its own. In the harness, the browser's clock is frozen to the API's
  `/health` time, so "how long ago" agrees with when the row was actually written.
- **The timeline printed database values at people**: "Sulthan attachment.created".
  `describeActivity` is an exhaustive switch over `ACTIVITY_ACTIONS` with no `default`,
  so a new action stops the build until it has words, and `activityEntrySchema.action`
  is the closed enum rather than `z.string()`. A unit test walks the list in case the
  type is ever widened back. `task.imported` turned out to be written by the import
  service and missing from the "closed" list entirely.
- **Hero figures used the page theme's colours.** The hero is dark in all four themes,
  so "Due today" in light was a dark brown-amber on navy. `.hero-surface` redefines
  `warning` and `info` as well as `success` and `danger`, and the token test measures
  the hero's colours against the hero's own background.
- **The theme control showed the wrong theme.** Setting `data-theme` on `<html>`
  repaints but tells the provider nothing, so the control kept showing whatever React
  still believed: a lit sun on a midnight screenshot. All three specs write the key the
  control writes, before navigating.
- **My Tasks columns did not line up at 1280.** The tracks were `auto`, so each row
  measured itself and a row with no action button put its due date where the row above
  put its status.

Also: Resume on blocked rows where the workflow allows it, "Waiting on you" instead of
"In review", board columns that scroll inside the viewport so every column header stays
visible, avatar plus first name in the task list, and a thumbnail that falls back to the
file-type icon when the bytes will not decode. Demo titles no longer end in
"[demo] 161": they are drawn without replacement from a shuffled pool, and the marker
that makes the seed idempotent moved to `meta` on the created activity row.

### The third review round

The last UI pass before deployment. Eight items; what is worth knowing later:

- **Plus Jakarta Sans is served from `apps/web/public/fonts`**, not from Google. The
  whole interface is set in it, so it is on the critical path, and a request to another
  origin on that path is a dependency on somebody else's DNS: one blip failed nineteen
  end-to-end tests at once. The latin subset of the variable font is 27KB, preloaded,
  `font-display: swap`. There was no CSP allowance to remove: the API's policy never
  listed Google, because the API does not serve the page.
- **My Tasks titles were cut mid-letter.** The fixed tracks added in round two left the
  title about 185px. The page is 1100px wide now and the title track has a 240px floor;
  `task-screens.spec.ts` measures how many characters actually fit and fails under
  forty. The percentage beside the progress bar is gone: it cost a track to repeat what
  the bar shows, and it is still in the aria-label.
- **The calendar knows which days are working days.** A new `GET /org/calendar` returns
  the weekend days and the holidays to anybody signed in; `/org/settings` stays behind
  `org.manage` because it also carries mail and digest configuration. Non-working days
  are hatched exactly as the heat map hatches them, with the holiday's name in the cell.
- **The calendar below 640px is a dot per task and a count**, with the chosen day listed
  in full underneath and today chosen by default. Chips shrunk to single letters at that
  width, which is a worse answer than not showing them.
- **A tinted pill may not sit on a tinted surface.** The new segmented priority control
  put one on `surface-muted`, which stacks two tints and cost the text the contrast the
  tokens give it on a card: axe measured 4.42:1. The track is the card colour now. Worth
  remembering, because the tokens cannot fix this one; the geometry has to.
- **Unread notifications for one task collapse into a line** ("4 updates from Rahul"),
  expandable, and marking the group read marks all of them. `actorName` was already
  stored on the notification; the list simply never passed it on. Read notifications are
  left alone: reordering a pile somebody has already been through helps nobody.
- The create drawer's project select, priority select and file input are the
  application's own controls now, not the operating system's.
- The demo seed puts due dates on working days, and the task the detail screenshot is
  taken of is seeded with its history spread across the last five working days. Posting
  that through the API stamped every row with the same second.

## Group tasks (v1.1)

One piece of work given to several people, each getting their own copy.

A **parent** carries the shared title, description, dates and priority. Its
**children** are the real tasks, one per person, each with its own key, its
own activity, its own comments and its own notification. Two rules hold it
together:

- **The parent is derived.** Status and progress are read off the children
  and never set by hand, and they are recomputed inside the same transaction
  as whatever changed a child. Recomputing afterwards would leave a window
  where a group says "3 of 8" with a fourth already complete, and that window
  is exactly when somebody refreshes.
- **The parent is never counted.** Every aggregate filters `is_group` out, or
  a group of eight would read as nine pieces of work and a lead's numbers
  would drift further from the truth the more the feature was used.

Cancelled children leave the denominator entirely: five of eight where one
person left is five of seven, not five of eight, and the other way round the
group could never reach 100%.

### What the feature needed from the rest of the product

- **`task.progress` was team-wide**, by design: progress is a collaborative
  signal like a comment. That is wrong for a group child, which is one
  person's share, so `TaskResource.inGroup` narrows it to the assignee and a
  lead. Ordinary tasks are unchanged.
- **`deriveParent` first read a finished child as "not started"**, so a group
  where one person had completed and the rest had not begun came back as
  Assigned. COMPLETED counts as started.
- `parentIsGroup` and `parentKey` are read as sub-selects on the row that is
  already being fetched, rather than as another query every time something is
  authorized or a child wants to name its group.

### Where it is used

| Surface | Behaviour |
| --- | --- |
| Create drawer | The assignee picker takes several people; two or more says "Each person gets their own task (group task)" before the button is pressed |
| Group detail | A People table (person, task, status, progress, due, last update) and a summary line, "5 of 8 done · 2 in progress · 1 blocked" |
| Child detail | A "Group: ERP-200" chip back to the parent |
| My Tasks | Each member sees only their own child, with the group link |
| Task list | A group is one line with a group icon; children are listed normally |
| Board | Containers hidden by default, with a "Show group rows" toggle (`?groups=true`) |
| Dashboard, alerts, digest, workload | Children only |

### Not built yet

Three items from the brief are not in this tag, and nothing pretends they
are:

- **Editing a parent does not offer to cascade.** Changing the parent's
  title, due date or priority leaves the children alone; there is no "Apply
  to the open personal tasks too?" prompt. `updateGroupSchema` and
  `GROUP_SHARED_FIELDS` are defined in `packages/shared` ready for it.
- **A parent's comments and attachments are not shown on its children.**
  Each child has its own, which works; the "From the group task" section is
  missing.
- **The digest lists children individually** rather than folding a group into
  one line. The counts are right either way, since children are what count.

## Accepted deviations

These are decided, not oversights. Do not "fix" them without asking.

- **React Email dropped.** Email is nodemailer with hand-written HTML templates. One
  dependency fewer, and the templates are small enough to read.
- **TanStack Table deferred to prompt 18.** It arrives with saved views and bulk
  actions, which is the first thing that actually needs it. Tables before then are
  plain `<table>`.
- **Lists of records stay real tables, not divs in a CSS grid.** The ask was fixed
  column widths so the columns line up, and `DataTable`
  (`apps/web/src/components/common/table.tsx`) gets that from `table-fixed` and a
  `<colgroup>`. Rebuilding them out of divs would line the columns up equally well and
  take the row and column semantics away from a screen reader, which the same prompt
  asked to protect. Card lists that are not tabular — My Tasks, the attention list, the
  notification rows — do use a CSS grid, because there is nothing to lose there.
- **Two screenshot runs, not one.** `pnpm e2e` writes the committed set to
  `e2e/screenshots`, which CI uploads so a visual change shows up in a diff. `pnpm
  shots` writes the review set to `e2e/.shots`, which is ignored. They are separate
  because the review set runs against the demo seed, and twelve weeks of generated
  history would break every test that counts the rows the ordinary seed creates. Both
  name files `<screen>-<theme>-<width>.png`.
- **Both runs freeze the browser clock to the API's `/health` time.** Every screen
  carries a relative time somewhere, so re-running the capture produced a diff on pages
  nothing had touched. The instant has to come from the API, because the server stamps
  the data and the browser renders "how long ago": freezing the browser three hours
  behind the server made every row it had just created read "in 3 hours". The committed
  set additionally masks `[data-time]` elements, because the database is rebuilt each
  run and two rows written three minutes apart differ by a pixel.
- **The review set is captured per role.** Member screens (My Tasks, task detail,
  board) as Rahul, lead screens as Sulthan, because a member sees different controls
  and shooting everything as a lead hides half of the product.
- **Leads can open `/admin/projects` and `/admin/import`.** The brief gives leads their
  own team's projects, so those two screens are lead-visible; every other admin screen
  is super-admin only. The server enforces the team boundary in both cases, so the
  route guard is only about not showing somebody a screen that would fail.
- **Markdown is rendered by a small reader written here**, not a library
  (`apps/web/src/components/common/Markdown.tsx`). It produces React elements, so a
  task description cannot inject markup, and it keeps a dependency out.
- **Quiet hours are switched off in the e2e database** (`apps/api/src/db/prepare-e2e.ts`).
  Otherwise "an email arrives" passes by day and fails after 20:00, which tells you
  about the clock rather than the code. Quiet hours keep their own integration tests.

## Known follow-ups

None of these is blocking. Each is a real gap, checked against the code today.

- **The Render deployment has not met the real services yet.** It was rehearsed end to end
  with stand-ins: the Render image capped at 512 MB and 0.1 CPU, PgBouncer in session mode
  for Supabase's pooler, an S3 server for Supabase Storage and B2, and a stub for Brevo's
  API. Not exercised: Supabase's TLS on the pooler, Supabase Storage's S3 quirks, Brevo's
  real API, and the two GitHub workflows on GitHub itself (the repository is not pushed).

- **Calendar bars.** `CalendarPage` groups tasks by `dueDate` only, so a task with a
  start date and a due date shows as a single dot on the last day instead of a bar
  across the range.
- **Drag to reschedule.** The calendar has no drag handlers at all; dropping a task on
  another day should move its due date, the way the board moves status.
- **Board swimlanes.** The board has columns and no grouping. Rows by assignee or by
  priority is the usual next ask from a lead with fifteen people.
- **Seed size.** The ordinary seed is still 20 tasks, which is what the e2e suite
  counts. `pnpm db:seed --demo` adds about 180 more for looking at the charts.
- **Infinite scroll.** The task list has a "Load more" button
  (`TasksPage.tsx`). The query is already an infinite query, so this is a scroll
  sentinel, not a rewrite.
- **Thumbnail batching.** `Attachments.tsx` fetches each image separately so the
  access check applies to the bytes. Fine for a handful; a task with twenty images
  makes twenty requests.
- **The dashboard team table needs a load % column, which arrives with Prompt 14.**
  It briefly had a "Share of open work" bar, but that drew the Active count a second
  time and said nothing new, so it was removed. What belongs there is how full each
  person's week is, and that needs the capacity-aware workload service.

- **The dashboard team picker has no test.** Added with `e48beb7`; by rule 15 that
  makes it PARTIAL until a web test covers choosing a team.
- **The Oracle runbook has not been run on a real A1 instance yet.** The images are
  proven on emulated arm64 and the backup scripts against a stand-in S3 server; the
  Oracle, Brevo and B2 console steps are written from their documentation.

Also worth knowing: a super admin on no team now gets a member digest rather than an
error, and `buildDigest` no longer throws for them.

## Running it

Docker Desktop must be running first — the dev database and Mailpit live in Compose,
and Testcontainers needs the daemon for the integration tests. Attachments are stored
on local disk in development (`apps/api/uploads/`), so there is no object store.

```sh
docker compose up -d          # Postgres 5433, Mailpit 1025 + UI 8025
pnpm install
pnpm db:migrate               # after pulling new migrations
pnpm db:seed                  # 7 users, password Password123!
pnpm db:seed --demo           # adds 12 weeks of history: use this to look at the charts
pnpm dev                      # API on 4000, web on 5174 (strict port)
```

`--demo` adds about 180 generated tasks on top of the ordinary seed, from a fixed random
seed and dated relative to now, so the dashboard is populated and two runs produce the
same database. It is idempotent, it refuses production, and the end-to-end suite never
uses it: those tests count the rows the ordinary seed creates.

Verification, in the order worth running it:

```sh
pnpm typecheck
pnpm lint
pnpm test                     # Vitest + Testcontainers; starts a real Postgres per file
pnpm e2e                      # Playwright; builds the web app and starts its own stack
pnpm shots                    # the review screenshots, demo-seeded, into e2e/.shots
```

`pnpm e2e` needs ports **4100** (API), **4101** (worker health) and **5199** (web) free.
An interrupted run leaves stray node and Chromium processes that will starve the next
one, so kill those before re-running. It uses its own database, `taskmanager_e2e`, which
is dropped and rebuilt every run.

Other commands: `pnpm build`, `pnpm smoke` (against a deployed site, with a dedicated
smoke-test account), `pnpm admin:create-user --role SUPER_ADMIN`, `pnpm db:reset`.

## Test counts as of 2026-10-06

| Suite | Files | Tests |
|-------|-------|-------|
| `packages/shared` unit | 1 | 23 |
| `apps/web` unit (tokens, contrast, wording) | 2 | 51 |
| `apps/api` integration | 26 | 431 |
| `apps/web` end-to-end (`pnpm e2e`, email on) | 14 | 61 |
| `apps/web` end-to-end, launch configuration (`pnpm e2e:all`: `RUN_MODE=all`, `MAIL_TRANSPORT=none`) | 14 | 59, and 2 mailbox tests skipped |

`review-shots.spec.ts` is not in that count: it runs only under `pnpm shots`, against a
different database.

All passing, with typecheck and lint clean.

A commit runs lint-staged through `.husky/pre-commit`, so ESLint and Prettier touch
every staged file on the way in. Expect formatting changes in the commit you just made.
