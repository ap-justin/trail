# trail

An agent-first issue tracker: bots write over REST and MCP, humans read and may only file issues and comment. Every write names the bot that made it (`~/.kru/management/trail/product.md`).

<!-- kru v0.179.0 · derived 2026-11-08 · `skills/setup/SKILL.md` to re-derive -->
## Team

Load **`skills/lead/SKILL.md`** before building, reviewing, or dispatching a seat — it carries how the team works.

The stack lives in `package.json`; the seats below are the product brief's (decided 2026-11-08 · /setup).

- **api** → `kru:hono-builder` — `src/server` routes, middleware, zod-openapi, SSE, the `/mcp` Streamable HTTP endpoint; Hono on `@hono/node-server`
- **data** → `kru:sqlite-architect` — `src/server/db` Drizzle schema and migrations on SQLite (better-sqlite3)
- **auth** → `kru:better-auth-specialist` — human GitHub OAuth sign-in with an allowlist; bot bearer keys are the api seat's, hashed, one per bot
- **ui** → `kru:react-ui-builder` — `src/web` components (Phase 3); routes and loaders in `src/web` → `kru:tanstack-start-builder` (TanStack Router, Start-less SPA)
- **tooling** → `kru:toolchain-engineer` — pnpm, biome, tsup, tsx config
- **tests** → `kru:test-writer` — sweeps and red suites; builders write their own red-green tests
- **skills** → `sqlite`, `drizzle`, `zod`, `vitest`, `api-design`; from Phase 3 `shadcn`, `tailwind` (v4)
- **screens** — none until Phase 3; `src/web` is a Vite SPA, design spec required before UI builders
- **test** — `pnpm test` runs vitest against a fresh temp SQLite file per test file ← decided
- **verify** — `.claude/skills/verify/SKILL.md` before every commit
- **mcp** — `context7` at user scope

Hosting: one Fly machine, SQLite on a volume; the server stays a plain Node process reading `DATABASE_PATH` and `PORT`.

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would need — never a nearby seat pressed into the gap.
