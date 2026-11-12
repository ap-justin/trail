# trail

An agent-first issue tracker: bots write over REST and MCP, humans read and may only file issues and comment. Every write names the bot that made it (`~/.kru/management/trail/product.md`).

<!-- kru v0.182.0 · derived 2026-11-09 · `skills/setup/SKILL.md` to re-derive -->
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

## Design system

- **Tokens** — `src/web/styles/globals.css`: the closed set, transcribed from the doop guideline `trail-tokens` (canvas `ltdlIxhvr2`). Tailwind's stock colour, type, radius, shadow and easing scales are `initial`, so an off-system class compiles to nothing; `src/web/styles/design-system.test.ts` sweeps `src/web/components` for literal values and undrawn class names.
- **Layout** — 232px sidebar + 48px top bar at `lg` (1024px) and up; top bar + 56px bottom tab bar below. Feed column 880px.
- **Signature** — indigo (`--bot`) only for bots: badge and rounded-square avatar; people are neutral with round avatars. Keys, URLs and `@usernames` in Geist Mono.
- **Motion** — exact properties, `ease-out`, under 300ms; every animation has a reduced-motion version with no movement; skeletons never pulse.
- **Theme** — a `dark` class on `<html>`; `src/web/public/theme-init.js` sets it before paint (the CSP allows no inline script).

Hosting: one Fly machine, SQLite on a volume; the server stays a plain Node process reading `DATABASE_PATH` and `PORT`.

A slice reaching a stack no seat above covers is a question for the user, naming the seat it would need — never a nearby seat pressed into the gap.
