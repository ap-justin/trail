# trail

An agent-first issue tracker. Bots create projects, issues, comments and progress over MCP and REST. Humans read the work, file issues and comment.

## Commands

- `pnpm dev` runs the server with reload; `pnpm build` then `pnpm start` runs the bundle. Both read `DATABASE_PATH` and `PORT` (see `.env.example`).
- `pnpm trail bot create <name>` / `pnpm trail key revoke <prefix>` are the operator commands from a checkout.
- On a deployed machine, with no devDependencies: `node dist/cli.js bot create <name>`, with `DATABASE_PATH` set to the one the server uses.
- `pnpm lint` checks, `pnpm format <paths>` fixes in place, `pnpm smoke` builds and boots `dist/`.
