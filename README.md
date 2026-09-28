# Team Task Manager

Internal task management for a software team. Team leads create, assign and review work and
get an accurate live view of team status; members update their own tasks.

The system shows **facts and evidence**. It never computes a performance score and never ranks
people. Every number on the dashboard links to the tasks behind it.

---

## Getting started

Requirements: Node 22+, pnpm 10+, Docker.

```bash
cp .env.example .env            # the defaults work for local development
docker compose up -d postgres mailpit
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Then open **http://localhost:5174**.

| Service        | Address                             |
| -------------- | ----------------------------------- |
| Web            | http://localhost:5174               |
| API (direct)   | http://localhost:4000/api/v1        |
| API (proxied)  | http://localhost:5174/api/v1        |
| Health check   | http://localhost:5174/api/v1/health |
| Mailpit inbox  | http://localhost:8025               |
| Postgres       | localhost:**5433**                  |

Postgres is on 5433 rather than 5432 so it does not clash with a local install.

### Ports and origins

Development is **same-origin**, like production. Vite proxies `/api` and `/socket.io`
through to the API, so the browser only ever talks to port 5174. The web API client uses the
relative base `/api/v1` and never hardcodes a host. That removes CORS and third-party cookie
problems in development and matches production, where Nginx serves both from one origin.

The web port is pinned: `strictPort` is on, so a clash **fails loudly** rather than moving to
another port. A moved port would change the cookie origin and silently break the session.
Change it with `WEB_PORT` in `.env` if 5174 is taken.

There is one `.env`, at the repository root; both apps read it.

| Variable       | What it does |
| -------------- | ------------ |
| `WEB_PORT`     | Vite dev server port (default 5174) |
| `API_URL`      | Where the dev proxy forwards `/api` and `/socket.io` |
| `WEB_ORIGIN`   | Canonical web address, used for links in emails |
| `CORS_ORIGINS` | Extra credentialed origins, comma separated; empty for a normal setup |

`WEB_ORIGIN` is always an allowed origin, so `CORS_ORIGINS` only matters for a deliberately
cross-origin deployment. A wildcard is rejected at start-up: the browser will not accept one
on a credentialed request anyway.

The refresh cookie is `httpOnly`, `sameSite=lax`, scoped to `/api/v1/auth`, and `Secure` only
when `NODE_ENV=production` — on plain `http://localhost` a Secure cookie would never be
stored and every refresh would fail.

### Seeded sign-ins

All seeded accounts use the password `Password123!` (set `SEED_PASSWORD` to change it).

| Email                  | Role       |
| ---------------------- | ---------- |
| `admin@example.com`    | Super admin |
| `sulthan@example.com`  | Team lead  |
| `rahul@example.com`    | Member     |
| `arun@example.com`     | Member     |
| `faisal@example.com`   | Member     |
| `akhil@example.com`    | Member     |

The seed creates two projects (ERP, CRM) and 20 tasks spread across every status, including
overdue, due today, blocked and in review. Re-running `pnpm db:seed` changes nothing —
it is idempotent. `pnpm db:reset` drops everything and rebuilds from migrations.

---

## Layout

```
apps/
  api/                 Express + Drizzle + Postgres
    src/
      config/          env parsing with Zod
      db/schema/       one file per area; migrations in drizzle/
      lib/             errors, logging, crypto, cursor, events, date-utils
      middleware/      authenticate, validate, error, rate limit
      modules/         <domain>/{routes,service,repo}.ts
      server.ts        HTTP entry
      worker.ts        background worker entry
    test/              integration tests against real Postgres
  web/                 React + Vite + Tailwind + TanStack Query
    src/
      app/             router, layout
      features/        <feature>/{api.ts, pages}
      components/      ui primitives and shared badges
      lib/             api client, query keys, utils
packages/
  shared/              Zod schemas, enums, the workflow table, metric definitions
```

The API and the worker are the same codebase started from two entry points, so a scheduled
job reuses the services and rules rather than reimplementing them.

---

## The rules the code keeps

These are the invariants worth knowing before changing anything.

**One workflow table.** `packages/shared/src/workflow.ts` decides every status change.
The API rejects anything it disallows, and the task detail response carries
`availableTransitions`, which is exactly what the UI renders as buttons. The UI cannot offer a
move the server would refuse, because both read the same table.

**Activity is written with the change.** Every task mutation writes its `task_activity`
rows and bumps `tasks.last_activity_at` inside the same transaction. If the change commits,
the history commits. `last_activity_at` is what makes the "no update in N hours" alert cheap.

**Status never moves outside the workflow.** `PATCH /tasks/:id` cannot touch `status` or
`assigneeId`; those have their own endpoints (`/transition`, `/assign`).

**Authorization happens in services, against loaded rows.** Routes apply a coarse role gate;
`authorize(actor, action, resource)` makes the real decision using the task's actual team,
assignee and reviewer. Role and team are never read from the client.

**Business dates use the org time zone.** Timestamps are `timestamptz` in UTC. Anything a
person would call a date — today, overdue, the next working day — goes through
`apps/api/src/lib/date-utils.ts`, which uses `org_settings.timezone`, the configured weekend
days and the holiday table.

**Task numbers cannot collide.** A new task takes its number from
`UPDATE projects SET task_counter = task_counter + 1 ... RETURNING` inside the creating
transaction, so simultaneous creates queue instead of clashing. There is a test for ten at once.

---

## Metric definitions

Written down once, in `packages/shared/src/metrics.ts`, so the dashboard, the digest and the
tests cannot drift apart. "Open" means any status except `COMPLETED` and `CANCELLED`.

| Metric | Rule |
| --- | --- |
| Active | Open and not Backlog |
| Due today | Open and due date is today, in the org time zone |
| Overdue | Open and due date is past; "days overdue" counts working days only |
| Blocked | Status is Blocked; age is hours since `blocked_at` |
| Waiting review | Ready for review or In review |
| Completed this week | `completed_at` inside the current week |
| No update | In progress and no activity for N **working** hours (default 24) |
| Median completion | Median of `completed_at` minus first In-progress time, last 30 days |
| On-time rate | Completed on or before the end of the due date ÷ completed with a due date |

The median, not the mean, so one unusual task does not distort the figure.

---

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | API and web together |
| `pnpm dev:worker` | The background worker |
| `pnpm build` | Build all three packages |
| `pnpm typecheck` | `tsc --noEmit` everywhere |
| `pnpm lint` | ESLint, zero warnings allowed |
| `pnpm test` | Unit and integration tests |
| `pnpm db:generate` | Generate a migration from the Drizzle schema |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:seed` | Seed development data (idempotent) |
| `pnpm db:reset` | Drop, migrate and seed again |

---

## Tests

Unit tests cover the workflow table, the permission matrix and the date rules — the three
places where a quiet mistake would be expensive. Integration tests run against a **real
Postgres** started by Testcontainers, because the things most likely to break here are
constraints, transactions and concurrency, which mocks cannot show.

`test/access.test.ts` exists to prove one thing repeatedly: a member or lead of team A cannot
read or change team B's data, through any route.

The first integration run pulls the `postgres:16-alpine` image, so it takes a minute.

---

## API conventions

- Everything under `/api/v1`.
- Lists use cursor pagination: `?cursor=&limit=`, and answer `{ items, nextCursor }`.
- Errors are always `{ error: { code, message, details? } }` with a matching HTTP status.
- Tasks are addressable by uuid **or** by key: `GET /api/v1/tasks/ERP-125`.
- Deleted tasks and comments are soft-deleted and excluded by default.

Access tokens live 15 minutes and are held in memory by the browser. The refresh token is an
httpOnly cookie scoped to `/api/v1/auth`; refreshing rotates it, and replaying a rotated token
revokes every session for that user.
