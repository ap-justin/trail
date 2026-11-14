// `pnpm trail <command>`: operator commands against DATABASE_PATH.
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadDatabaseConfig } from "./config.js";
import { type Db, migrate, openDatabase } from "./db/client.js";
import { ValidationError } from "./service/errors.js";
import {
  createBot,
  createKey,
  type KeyScopeInput,
  type KeyScopeView,
  listKeys,
  renameBot,
  revokeKey,
  setBotTitle,
} from "./service/keys.js";
import { BOT_TITLE_MAX } from "./service/validate.js";

interface Output {
  write(chunk: string): unknown;
}

export interface CliIo {
  stdout: Output;
  stderr: Output;
  env?: NodeJS.ProcessEnv;
}

const usage = `Usage:
  trail bot create <name> [--label <agent-id>] [<scope>] [--key-only]
                                   create a bot and print its key once
  trail bot rename <bot-id-label-or-name> <new name>
                                   change a bot's display name; its keys stay
  trail bot title <bot-id-label-or-name> <title>
  trail bot title <bot-id-label-or-name> --clear
                                   set a bot's title, 1 to ${BOT_TITLE_MAX} characters, shown
                                   beside its name; or remove it
  trail key create <bot-id-or-label> [<scope>] [--key-only]
                                   mint another key for an existing bot
  trail key list                   list every key's prefix, bot, times and scope
  trail key revoke <prefix>        revoke a key by its prefix or the full key

  --label <agent-id>  the bot's id in the system that runs it, unique among bots
  --projects <keys>   scope: limit the key to these projects, like BGP,ATL
  --actions <actions> scope: limit the key to these of read, issues, comments,
                      status_updates and admin, like read,issues,comments
  --key-only          print only the key on stdout; the rest goes to stderr
  --clear             bot title: remove the title instead of setting one

  <scope> is --projects, --actions or both. A key without --projects reaches
  every project; without --actions it has every action.
`;

const options = {
  help: { type: "boolean", short: "h" },
  label: { type: "string" },
  projects: { type: "string" },
  actions: { type: "string" },
  "key-only": { type: "boolean" },
  clear: { type: "boolean" },
} as const;

type Flags = {
  label?: string;
  projects?: string;
  actions?: string;
  "key-only"?: boolean;
  clear?: boolean;
};

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
    const db = openDatabase(
      existingDatabase(loadDatabaseConfig(io.env ?? process.env).DATABASE_PATH),
    );
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

/** The path, refused when no file is there, so a mistyped DATABASE_PATH can't mint keys into a new empty database. */
function existingDatabase(path: string): string {
  if (!existsSync(path)) {
    throw new Error(
      `no database at ${resolve(path)}: set DATABASE_PATH to the server's database file (/data/trail.db on Fly) and retry; the server creates the file on its first start`,
    );
  }
  return path;
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

const projectsCell = (scope: KeyScopeView) =>
  scope.projects?.join(",") ?? "all projects";
const actionsCell = (scope: KeyScopeView) =>
  scope.actions?.join(",") ?? "all actions";

/** `scope  projects BGP; all actions`, or nothing for an unscoped key. */
function scopeLine(scope: KeyScopeView): string {
  if (scope.projects === null && scope.actions === null) return "";
  const projects = scope.projects
    ? `projects ${projectsCell(scope)}`
    : projectsCell(scope);
  const actions = scope.actions
    ? `actions ${actionsCell(scope)}`
    : actionsCell(scope);
  return `scope  ${projects}; ${actions}\n`;
}

/**
 * The actor and key lines on stdout, or with --key-only the key alone and the
 * actor on stderr. A scoped key adds a scope line on the actor line's stream;
 * an unscoped one prints nothing more.
 */
function printKey(
  db: Db,
  io: CliIo,
  created: { actor: { id: string }; key: string },
  keyOnly: boolean,
): void {
  const listed = listKeys(db).find(
    (k) => k.prefix === created.key.slice(6, 14),
  );
  const scope = listed ? scopeLine(listed.scope) : "";
  if (keyOnly) {
    io.stdout.write(`${created.key}\n`);
    io.stderr.write(`actor  ${created.actor.id}\n${scope}`);
  } else {
    io.stdout.write(
      `actor  ${created.actor.id}\nkey    ${created.key}\n${scope}`,
    );
  }
  io.stderr.write("store this key now: it can't be shown again\n");
}

/** The comma-separated value of a list flag; a blank entry is refused here, before the database opens. */
function listFlag(
  flag: "projects" | "actions",
  value: string | undefined,
): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => item === "")) {
    throw new UsageError(
      `--${flag} takes a comma-separated list with no blank entries, like --${flag}=${flag === "projects" ? "BGP,ATL" : "read,issues"}; leave it out for no limit`,
    );
  }
  return items;
}

function scopeFlags(flags: Flags): KeyScopeInput {
  const projects = listFlag("projects", flags.projects);
  const actions = listFlag("actions", flags.actions);
  return {
    ...(projects && { projects }),
    ...(actions && { actions }),
  };
}

const botCreate: Command<{
  name: string;
  label?: string;
  scope: KeyScopeInput;
  keyOnly: boolean;
}> = {
  flags: ["label", "projects", "actions", "key-only"],
  parse: (args, flags) => ({
    name: oneArg(args, "name"),
    label: flags.label,
    scope: scopeFlags(flags),
    keyOnly: flags["key-only"] === true,
  }),
  run(db, { name, label, scope, keyOnly }, io) {
    printKey(db, io, createBot(db, name, { label, scope }), keyOnly);
  },
};

const keyCreate: Command<{
  bot: string;
  scope: KeyScopeInput;
  keyOnly: boolean;
}> = {
  flags: ["projects", "actions", "key-only"],
  parse: (args, flags) => ({
    bot: oneArg(args, "bot-id-or-label"),
    scope: scopeFlags(flags),
    keyOnly: flags["key-only"] === true,
  }),
  run(db, { bot, scope, keyOnly }, io) {
    printKey(db, io, createKey(db, bot, scope), keyOnly);
  },
};

const keyList: Command<null> = {
  flags: [],
  parse(args) {
    if (args.length > 0) throw new UsageError("'key list' takes no arguments");
    return null;
  },
  run(db, _, io) {
    const rows = [
      [
        "prefix",
        "actor",
        "name",
        "label",
        "created",
        "revoked",
        "projects",
        "actions",
      ],
      ...listKeys(db).map((k) => [
        k.prefix,
        k.actorId,
        k.displayName,
        k.label ?? "-",
        k.createdAt.toISOString(),
        k.revokedAt?.toISOString() ?? "-",
        projectsCell(k.scope),
        actionsCell(k.scope),
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

const botRename: Command<{ bot: string; name: string }> = {
  flags: [],
  parse(args) {
    if (args.length === 0)
      throw new UsageError("missing <bot-id-label-or-name>");
    if (args.length === 1) throw new UsageError("missing <new name>");
    // an unquoted multi-word name arrives as several arguments
    return { bot: args[0] as string, name: args.slice(1).join(" ") };
  },
  run(db, { bot, name }, io) {
    const renamed = renameBot(db, bot, name);
    io.stdout.write(
      `actor  ${renamed.id}\nfrom   ${renamed.oldName}\nto     ${renamed.newName}\n`,
    );
  },
};

const botTitle: Command<{ bot: string; title: string | null }> = {
  flags: ["clear"],
  parse(args, flags) {
    if (args.length === 0)
      throw new UsageError("missing <bot-id-label-or-name>");
    const [bot, ...words] = args as [string, ...string[]];
    if (flags.clear) {
      if (words.length > 0) {
        throw new UsageError("'bot title --clear' takes no <title>");
      }
      return { bot, title: null };
    }
    if (words.length === 0) {
      throw new UsageError("missing <title>, or --clear to remove it");
    }
    // an unquoted multi-word title arrives as several arguments
    return { bot, title: words.join(" ") };
  },
  run(db, { bot, title }, io) {
    const set = setBotTitle(db, bot, title);
    io.stdout.write(
      `actor  ${set.id}\nfrom   ${set.oldTitle ?? "-"}\nto     ${set.newTitle ?? "-"}\n`,
    );
  },
};

// method syntax in Command keeps run() bivariant, so each command keeps its own input type
const commands: Record<string, Command<unknown> | undefined> = {
  "bot create": botCreate,
  "bot rename": botRename,
  "bot title": botTitle,
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
