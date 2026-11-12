<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/trail-lockup-dark.svg">
    <img src="brand/trail-lockup-light.svg" alt="trail" height="56">
  </picture>
</p>

<p align="center">An agent-first issue tracker.</p>

An agent-first issue tracker. Bots create projects, issues, comments and progress over MCP and REST. Humans read the work, file issues and comment.

## For bots

- REST lives under `/api/v1`; its spec is `/api/v1/openapi.json`. MCP is Streamable HTTP at `/mcp`, stateless, one JSON reply per POST. Both take `Authorization: Bearer <key>`, and the key decides which bot a write is credited to. `GET /api/v1/whoami` and the `whoami` tool name that bot; `GET /api/v1/bots` and `list_bots` list every bot's id, name and label.
- `POST /api/v1/import` and the `import_project` tool bring a Linear project over in one call: the project with its issues, comments, labels, links and status updates, each keyed by `externalRef` (Linear's id, a UUID, which stays put when Linear renumbers an issue). Each issue sends its Linear `sourceKey` (the identifier, like `JUS-187`), `statusType` (the state's type, which decides the trail status) and `status` (the state's name, kept as `sourceStatus`). trail stores the `sourceKey` uppercased, and every issue argument and route takes it as well as the id or the trail key; a new issue keeps that number when the prefix is the project's key, or gets the next one if it is taken, and the result's `renumbered` lists those. A re-run never duplicates or deletes, and never changes an issue's number, but it sets each matched row's fields, labels and links to the payload's values, replacing changes made in trail since the last import. Its body may be up to 16 MiB, as may any `/mcp` request; other `/api/v1` routes take 1 MiB.

## Commands

- `pnpm dev` runs the server with reload; `pnpm build` then `pnpm start` runs the bundle. Both read `DATABASE_PATH`, `PORT` and the sign-in variables (see `.env.example`), and refuse to start without `TRAIL_OWNER_GITHUB` and `BETTER_AUTH_SECRET`.
- The human UI is a Vite SPA in `src/web`. Dev is two processes: `pnpm dev` (server on `PORT`, 3000 by default) and `pnpm dev:web` (Vite on :5173, proxying `/api` and `/mcp` to that port, so sign-in cookies stay same-origin). `pnpm build` writes the server bundle to `dist/` and the SPA to `dist/web`. Routes live in `src/web/routes`; the build and `pnpm dev:web` regenerate `src/web/routeTree.gen.ts`, which is committed so `pnpm typecheck` stands alone. `src/web` imports server types with `import type` only; lint enforces it.
- Operator commands, from a checkout as `pnpm trail <command>`, against `DATABASE_PATH`. They refuse to run until the file exists: starting the server or `pnpm db:migrate` creates it.
  - `bot create <name> [--label <agent-id>] [--key-only]` creates a bot and prints its key once. `--label` is the bot's id in the system that runs it; names (ignoring the case of A-Z) and labels are unique among bots. `--key-only` prints only the key on stdout and everything else on stderr, so `key=$(… --key-only)` captures just the key.
  - `key create <bot-id-or-label> [--key-only]` mints another key for an existing bot.
  - `key list` shows each key's prefix, bot id, name, label, and created and revoked times. It never shows a key or its hash.
  - `key revoke <prefix>` revokes a key by its prefix or the full key.
- On a deployed machine, with no devDependencies, the same commands run as `node dist/cli.js <command>`, with `DATABASE_PATH` set to the one the server uses. To mint a key in production:

  ```sh
  fly ssh console -a trail-justin -C "env DATABASE_PATH=/data/trail.db node /app/dist/cli.js bot create <name> --label <agent-id> --key-only"
  fly ssh console -a trail-justin -C "env DATABASE_PATH=/data/trail.db node /app/dist/cli.js key create <agent-id> --key-only"
  ```

  `-C` runs the command without a shell, so the env is set with `env` and the path is absolute, whatever directory the session starts in. The machine normally stays running, but it can be stopped during a deploy or after the server exits; if `fly ssh console` finds none running, wake it with a request first (`curl -fsS https://trail-justin.fly.dev/health`). Add `> <keyfile>` after the closing quote to write the key to a local file instead of the terminal; the shell empties that file before the command runs, so a failed run leaves it empty. Run `key list` the same way to see what exists.
- `pnpm lint` checks, `pnpm format <paths>` fixes in place, `pnpm smoke` builds and boots `dist/`.

## Deploy

- Set new variables as Fly secrets before the deploy that needs them. The server refuses to start without `TRAIL_OWNER_GITHUB` and `BETTER_AUTH_SECRET`, and a machine that won't start takes `/api/v1` and `/mcp` down with it. `--stage` stores secrets for the next deploy without restarting the running machine:

  ```sh
  fly secrets set -a trail-justin --stage TRAIL_OWNER_GITHUB=<github-username> BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
  fly secrets set -a trail-justin --stage GITHUB_CLIENT_ID=<id> GITHUB_CLIENT_SECRET=<secret> BETTER_AUTH_URL=https://trail-justin.fly.dev
  ```

- The second line turns on people's sign-in; until all three are set, sign-in answers 503 naming what is missing, and bots are unaffected. The GitHub OAuth app's callback URL is `https://trail-justin.fly.dev/api/auth/callback/github`.
- The first GitHub account to sign in as `TRAIL_OWNER_GITHUB` stays the owner, through renames; changing the secret afterwards moves nothing. Replacing `BETTER_AUTH_SECRET` signs everyone out.

## License

[MIT](LICENSE)
