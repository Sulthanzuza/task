# Status

Where the build has got to. Read this first; update it when you finish a prompt.

Last updated: 2026-09-30. Branch `master`, head `3e968ae`.

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

## Accepted deviations

These are decided, not oversights. Do not "fix" them without asking.

- **React Email dropped.** Email is nodemailer with hand-written HTML templates. One
  dependency fewer, and the templates are small enough to read.
- **TanStack Table deferred to prompt 18.** It arrives with saved views and bulk
  actions, which is the first thing that actually needs it. Tables before then are
  plain `<table>`.
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
- **Seed size.** 20 tasks. Enough to see every screen work, not enough to see paging,
  a slow query or a crowded board. A larger optional seed would make the deferred
  performance work measurable.
- **Infinite scroll.** The task list has a "Load more" button
  (`TasksPage.tsx`). The query is already an infinite query, so this is a scroll
  sentinel, not a rewrite.
- **Thumbnail batching.** `Attachments.tsx` fetches each image separately so the
  access check applies to the bytes. Fine for a handful; a task with twenty images
  makes twenty requests.

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
pnpm dev                      # API on 4000, web on 5174 (strict port)
```

Verification, in the order worth running it:

```sh
pnpm typecheck
pnpm lint
pnpm test                     # Vitest + Testcontainers; starts a real Postgres per file
pnpm e2e                      # Playwright; builds the web app and starts its own stack
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
| `apps/api` integration | 19 | 358 |
| `apps/web` end-to-end | 12 | 47 |

All passing, with typecheck and lint clean, at `3e968ae`.

A commit runs lint-staged through `.husky/pre-commit`, so ESLint and Prettier touch
every staged file on the way in. Expect formatting changes in the commit you just made.
