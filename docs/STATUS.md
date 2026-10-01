# Status

Where the build has got to. Read this first; update it when you finish a prompt.

Last updated: 2026-10-01. Branch `master`, head `5269072` plus the review fixes below.

## Built, by prompt

Prompts come from `Team Task Management System — Build Plan & Prompts.docx` in the repo root.

| # | Prompt | State | Where |
|---|--------|-------|-------|
| 1 | CLAUDE.md | Done — project rules, 15 of them; rule 15 defines DONE as API + UI + test | `CLAUDE.md` |
| 2 | Scaffold the monorepo | Done — pnpm workspaces (`apps/api`, `apps/web`, `packages/shared`), Docker Compose (Postgres 5433, Mailpit 1025/8025, MinIO 9000/9001), ESLint, Prettier, CI | `pnpm-workspace.yaml`, `docker-compose.yml`, `.github/` |
| 3 | Database schema, migrations, seed | Done — Drizzle schema split by domain, generated migrations, idempotent seed of 7 users / 2 teams / 3 projects / 20 tasks | `apps/api/src/db/` |
| 4 | Authentication | Done — login, refresh with rotation and reuse detection, logout, set/reset password, rate limits, cross-tab refresh via `navigator.locks` | `apps/api/src/modules/auth/`, `apps/web/src/lib/api.ts` |
| 5 | Permissions, teams, projects | Done — one `authorize(actor, action, resource)` matrix; teams and members; projects with immutable keys and archive; labels | `apps/api/src/modules/permissions/authorize.ts`, `modules/teams/`, `modules/projects/` |
| 6 | Tasks API, workflow, activity log | Done — CRUD, shared workflow transition table, transitions, assign with handover, progress, dependencies with cycle refusal, watchers, soft delete; every mutation writes activity in the same transaction | `packages/shared/src/workflow.ts`, `apps/api/src/modules/tasks/` |
| 7 | Comments, mentions, watchers, attachments | Done — comments with `@[Name](userId)` mentions, watcher rules, attachments typed by magic bytes rather than by what the client claimed | `apps/api/src/modules/comments/`, `modules/attachments/`, `lib/fileType.ts` |
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
| `696e511` | Design system: four themes as tokens, the top-bar shell, `/design` |
| `30ad223` | Responsive top bar: pill icons down to 900px, identity into the account menu |
| `a5313f0` | Dashboard redesign, the chart set, and `pnpm db:seed --demo` |
| `5269072` | The design system applied to every remaining screen (below) |
| _this one_ | The fixes from the screenshot review (below) |

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
- **Both runs freeze the browser clock at today 09:30 in the org zone.** Every screen
  carries a relative time somewhere, so re-running the capture produced a diff on pages
  nothing had touched. It is *today* rather than a fixed date because the API has its
  own clock and nothing can freeze that from outside: pinning the browser to a date the
  server disagrees with would make every screen claim the work is weeks overdue. Two
  runs on the same day are now identical, which is what the diffs were about.
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

Also worth knowing: a super admin on no team now gets a member digest rather than an
error, and `buildDigest` no longer throws for them.

## Running it

Docker Desktop must be running first — the dev database, Mailpit and MinIO all live in
Compose, and Testcontainers needs the daemon for the integration tests.

```sh
docker compose up -d          # Postgres 5433, Mailpit 1025 + UI 8025, MinIO 9000/9001
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

## Test counts as of 2026-09-30

| Suite | Files | Tests |
|-------|-------|-------|
| `packages/shared` unit | 1 | 23 |
| `apps/web` unit (tokens and contrast) | 1 | 37 |
| `apps/api` integration | 20 | 376 |
| `apps/web` end-to-end | 13 | 56 |

`review-shots.spec.ts` is not in that count: it runs only under `pnpm shots`, against a
different database.

All passing, with typecheck and lint clean.

A commit runs lint-staged through `.husky/pre-commit`, so ESLint and Prettier touch
every staged file on the way in. Expect formatting changes in the commit you just made.
