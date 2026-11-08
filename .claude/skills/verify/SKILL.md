---
name: verify
description: Lint, typecheck, test and live-check trail before a commit.
---

Run from the repo root once code exists; skip any step whose script is not yet in `package.json`.

1. `pnpm lint && pnpm typecheck`
2. `pnpm test` (each test file opens its own temp SQLite file; no service to start).
3. Live check: `DATABASE_PATH=$(mktemp -d)/trail.db PORT=3000 pnpm dev` in the background, then `curl -fsS localhost:3000/health`, and call each REST route with a bot key, `curl -fsS -H "Authorization: Bearer $TRAIL_BOT_KEY" localhost:3000/<route>`. Stop the server afterwards.

Screenshots and logs go under `proof/`. Red → fix it before the commit; the commit waits.
