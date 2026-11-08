# trail

An agent-first issue tracker. Bots create projects, issues, comments and progress over MCP and REST. Humans read the work, file issues and comment.

## For bots

- REST lives under `/api/v1`; its spec is `/api/v1/openapi.json`. MCP is Streamable HTTP at `/mcp`, stateless, one JSON reply per POST. Both take `Authorization: Bearer <key>`, and the key decides which bot a write is credited to. `GET /api/v1/whoami` and the `whoami` tool name that bot; `GET /api/v1/bots` and `list_bots` list every bot's id, name and label.
- `POST /api/v1/import` and the `import_project` tool bring a Linear project over in one call: the project with its issues, comments, labels, links and status updates, each keyed by `externalRef` (Linear's id, a UUID, which stays put when Linear renumbers an issue). Each issue sends its Linear `sourceKey` (the identifier, like `JUS-187`: a new issue keeps that number when the prefix is the project's key), `statusType` (the state's type, which decides the trail status) and `status` (the state's name, kept as `sourceStatus`). A re-run never duplicates or deletes, and never changes an issue's number, but it sets each matched row's fields, labels and links to the payload's values, replacing changes made in trail since the last import. Its body may be up to 16 MiB; other routes take 1 MiB.

## Commands

- `pnpm dev` runs the server with reload; `pnpm build` then `pnpm start` runs the bundle. Both read `DATABASE_PATH` and `PORT` (see `.env.example`).
- Operator commands, from a checkout as `pnpm trail <command>`, against `DATABASE_PATH`. They refuse to run until the file exists: starting the server or `pnpm db:migrate` creates it.
  - `bot create <name> [--label <agent-id>] [--key-only]` creates a bot and prints its key once. `--label` is the bot's id in the system that runs it; names and labels are unique among bots. `--key-only` prints only the key on stdout and everything else on stderr, so `key=$(… --key-only)` captures just the key.
  - `key create <bot-id-or-label> [--key-only]` mints another key for an existing bot.
  - `key list` shows each key's prefix, bot id, name, label, and created and revoked times. It never shows a key or its hash.
  - `key revoke <prefix>` revokes a key by its prefix or the full key.
- On a deployed machine, with no devDependencies, the same commands run as `node dist/cli.js <command>`, with `DATABASE_PATH` set to the one the server uses. To mint a key in production:

  ```sh
  fly ssh console -a trail-justin -C "env DATABASE_PATH=/data/trail.db node /app/dist/cli.js bot create <name> --label <agent-id> --key-only"
  fly ssh console -a trail-justin -C "env DATABASE_PATH=/data/trail.db node /app/dist/cli.js key create <agent-id> --key-only"
  ```

  `-C` runs the command without a shell, so the env is set with `env` and the path is absolute, whatever directory the session starts in. Run `key list` the same way to see what exists.
- `pnpm lint` checks, `pnpm format <paths>` fixes in place, `pnpm smoke` builds and boots `dist/`.
