// `pnpm trail <command>`: operator commands against DATABASE_PATH.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { type Db, migrate, openDatabase } from "./db/client.js";
import { ValidationError } from "./service/errors.js";
import { createBot, createKey, listKeys, revokeKey } from "./service/keys.js";

interface Output {
  write(chunk: string): unknown;
}

export interface CliIo {
  stdout: Output;
  stderr: Output;
  env?: NodeJS.ProcessEnv;
}

const usage = `Usage:
  trail bot create <name> [--label <agent-id>] [--key-only]
                                   create a bot and print its key once
  trail key create <bot-id-or-label> [--key-only]
                                   mint another key for an existing bot
  trail key list                   list every key's prefix, bot and times
  trail key revoke <prefix>        revoke a key by its prefix or the full key

  --label <agent-id>  the bot's id in the system that runs it, unique among bots
  --key-only          print only the key on stdout; the rest goes to stderr
`;

const options = {
  help: { type: "boolean", short: "h" },
  label: { type: "string" },
  "key-only": { type: "boolean" },
} as const;

type Flags = { label?: string; "key-only"?: boolean };

class UsageError extends Error {}

/** Runs one operator command and returns its exit status: 0 ok, 1 failed, 2 usage error. */
export function runCli(argv: readonly string[], io: CliIo): number {
  let positionals: string[];
  let help: boolean | undefined;
  let flags: Flags;
  try {
    ({
      positionals,
      values: { help, ...flags },
    } = parseArgs({ args: [...argv], options, allowPositionals: true }));
  } catch (e) {
    if (!(e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS_")) throw e;
    return usageError(io, (e as Error).message);
  }
  if (help) {
    io.stdout.write(usage);
    return 0;
  }

  const [noun, verb, ...args] = positionals;
  const command = commands[`${noun} ${verb}`];
  if (!command) {
    return usageError(
      io,
      noun === undefined
        ? "missing command"
        : `unknown command '${positionals.slice(0, 2).join(" ")}'`,
    );
  }

  try {
    for (const flag of Object.keys(flags)) {
      if (!command.flags.includes(flag as keyof Flags)) {
        throw new UsageError(`'${noun} ${verb}' takes no --${flag}`);
      }
    }
    const input = command.parse(args, flags);
    const db = openDatabase(loadConfig(io.env ?? process.env).DATABASE_PATH);
    try {
      migrate(db);
      command.run(db, input, io);
    } finally {
      db.$client.close();
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError || e instanceof ValidationError) {
      return usageError(io, e.message);
    }
    io.stderr.write(`trail: ${(e as Error).message}\n`);
    return 1;
  }
}

function usageError(io: CliIo, message: string): number {
  io.stderr.write(`trail: ${message}\n${usage}`);
  return 2;
}

function oneArg(args: readonly string[], name: string): string {
  if (args.length === 0) throw new UsageError(`missing <${name}>`);
  if (args.length > 1) {
    throw new UsageError(
      `expected one <${name}>, got ${args.length}; quote a value containing spaces`,
    );
  }
  return args[0] as string;
}

interface Command<T> {
  flags: readonly (keyof Flags)[];
  parse(args: readonly string[], flags: Flags): T;
  run(db: Db, input: T, io: CliIo): void;
}

/** The actor and key lines on stdout, or with --key-only the key alone and the actor on stderr. */
function printKey(
  io: CliIo,
  created: { actor: { id: string }; key: string },
  keyOnly: boolean,
): void {
  if (keyOnly) {
    io.stdout.write(`${created.key}\n`);
    io.stderr.write(`actor  ${created.actor.id}\n`);
  } else {
    io.stdout.write(`actor  ${created.actor.id}\nkey    ${created.key}\n`);
  }
  io.stderr.write("store this key now: it can't be shown again\n");
}

const botCreate: Command<{ name: string; label?: string; keyOnly: boolean }> = {
  flags: ["label", "key-only"],
  parse: (args, flags) => ({
    name: oneArg(args, "name"),
    label: flags.label,
    keyOnly: flags["key-only"] === true,
  }),
  run(db, { name, label, keyOnly }, io) {
    printKey(io, createBot(db, name, { label }), keyOnly);
  },
};

const keyCreate: Command<{ bot: string; keyOnly: boolean }> = {
  flags: ["key-only"],
  parse: (args, flags) => ({
    bot: oneArg(args, "bot-id-or-label"),
    keyOnly: flags["key-only"] === true,
  }),
  run(db, { bot, keyOnly }, io) {
    printKey(io, createKey(db, bot), keyOnly);
  },
};

const keyList: Command<null> = {
  flags: [],
  parse(args) {
    if (args.length > 0) throw new UsageError("key list takes no arguments");
    return null;
  },
  run(db, _, io) {
    const rows = [
      ["prefix", "actor", "name", "label", "created", "revoked"],
      ...listKeys(db).map((k) => [
        k.prefix,
        k.actorId,
        k.displayName,
        k.label ?? "-",
        k.createdAt.toISOString(),
        k.revokedAt?.toISOString() ?? "-",
      ]),
    ];
    const widths = rows[0]?.map((_, i) =>
      Math.max(...rows.map((r) => (r[i] as string).length)),
    ) as number[];
    for (const row of rows) {
      const cells = row.map((cell, i) =>
        i === row.length - 1 ? cell : cell.padEnd(widths[i] as number),
      );
      io.stdout.write(`${cells.join("  ")}\n`);
    }
  },
};

// a bare prefix, or anything starting `trail_<prefix>` — the full key or a truncated paste of it
const prefixPattern = /^(?:trail_)?([0-9a-f]{8})(?:_|$)/;

const keyRevoke: Command<string> = {
  flags: [],
  parse(args) {
    const prefix = prefixPattern.exec(oneArg(args, "prefix"))?.[1];
    if (prefix === undefined) {
      throw new UsageError(
        "<prefix> must be 8 hex characters, or a key starting trail_<prefix>_",
      );
    }
    return prefix;
  },
  run(db, prefix, io) {
    const { actorId, revokedAt } = revokeKey(db, prefix);
    io.stdout.write(
      `revoked trail_${prefix} (actor ${actorId}) at ${revokedAt.toISOString()}\n`,
    );
  },
};

// method syntax in Command keeps run() bivariant, so each command keeps its own input type
const commands: Record<string, Command<unknown> | undefined> = {
  "bot create": botCreate,
  "key create": keyCreate,
  "key list": keyList,
  "key revoke": keyRevoke,
};

function isMain(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return (
      realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMain()) {
  // a reader that stops early (`| head`) is not a failure
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "EPIPE") throw e;
    process.exitCode = 0;
  });
  // exitCode, not exit(): lets piped stdout drain
  process.exitCode = runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
