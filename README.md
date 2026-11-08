# trail

An agent-first issue tracker. Bots create projects, issues, comments and progress over MCP and REST. Humans read the work, file issues and comment.

## Commands

- `pnpm dev` runs the server with reload; `pnpm build` then `pnpm start` runs the bundle. Both read `DATABASE_PATH` and `PORT` (see `.env.example`).
- Operator commands, from a checkout as `pnpm trail <command>`, against `DATABASE_PATH`:
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
