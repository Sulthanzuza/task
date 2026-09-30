# Team Task Manager: project rules

## Product
Internal task management system for a software team. Roles: SUPER_ADMIN, TEAM_LEAD, MEMBER.
Team Leads create, assign and review tasks and need an accurate real-time view of team status.
Members update their own tasks. The system shows facts and evidence; it never computes a
"performance score" or ranks people.

## Stack
- pnpm workspaces: apps/api, apps/web, packages/shared
- API: Node LTS, Express, TypeScript strict, Drizzle ORM + drizzle-kit, PostgreSQL 16,
  pg-boss, Socket.IO, pino, Zod
- Web: React, Vite, TypeScript strict, React Router, TanStack Query,
  Tailwind, shadcn/ui, React Hook Form, dnd-kit, Recharts
  (TanStack Table arrives with Prompt 18, for saved views and bulk actions)
- Tests: Vitest, Supertest, Testcontainers (real Postgres), Playwright
- Email: nodemailer with hand-written HTML templates
- Tooling: tsx (runs the API and scripts in dev), tsup (bundles the API for production)

## Rules
1. Validate every body, param and query with Zod schemas from packages/shared. Web forms use the same schemas.
2. Enums (status, priority, role, blocker type) and the workflow transition table live in packages/shared only.
3. Every task mutation writes task_activity row(s) and updates tasks.last_activity_at in the SAME transaction.
4. Status changes go only through the workflow service (canTransition). No endpoint sets status directly.
5. Auth: authenticate middleware + authorize(actor, action, resource) in services. Never trust role or team from the client.
6. Store timestamps as timestamptz (UTC). Business dates (today, overdue, working days) use
   org_settings.timezone, weekend days and holidays via one date-utils module.
7. REST under /api/v1. Cursor pagination (?cursor=&limit=). Errors: { error: { code, message, details } } with correct HTTP status.
8. Soft delete tasks and comments (deleted_at); exclude them by default.
9. API layout: modules/<domain>/{routes.ts, service.ts, repo.ts, *.test.ts}. Routes are thin; logic in services.
10. Web: data access only through TanStack Query hooks in features/<feature>/api.ts; keys in lib/queryKeys.ts.
11. Every endpoint gets an integration test; every workflow and date rule gets unit tests.
12. Config from env parsed with Zod in config/env.ts; keep .env.example current. No secrets in code.
13. Small functions, plain names, no speculative abstractions. Ask before adding a dependency not listed here.
14. When done: run typecheck, lint, tests; report what changed and what is left.
15. A feature is DONE only when it has its API, its UI, and a test. Report anything missing
    one of these as PARTIAL, never as done.
16. Read docs/STATUS.md at the start of every session; update it at the end of every prompt.

## Glossary
Task key = project key + number (ERP-125). Open = status not COMPLETED or CANCELLED.
Working day = not a weekend day and not a holiday per org_settings.