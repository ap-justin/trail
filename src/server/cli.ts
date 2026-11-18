// `pnpm trail <command>`: operator commands against DATABASE_PATH.
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inArray } from "drizzle-orm";
import { loadDatabaseConfig } from "./config.js";
import { type Db, migrate, openDatabase } from "./db/client.js";
import { project } from "./db/schema.js";
import { ValidationError } from "./service/errors.js";
import {
  andList,
  createBot,
  createKey,
  editKeyScope,
  type KeyScopeEdit,
  type KeyScopeInput,
  type KeyScopeView,
  listKeys,
  renameBot,
  revokeKey,
  setBotLabel,
  setBotTitle,
} from "./service/keys.js";
import {
  listProductOwners,
  type ProductChange,
  setProductOwner,
  setProductRepo,
} from "./service/product-admin.js";
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
  trail bot label <bot-id-label-or-name> <agent-id>
  trail bot label <bot-id-label-or-name> --clear
                                   set a bot's label, unique among bots; or
                                   remove it; its keys stay
  trail key create <bot-id-or-label> [<scope>] [--key-only]
                                   mint another key for an existing bot
  trail key scope <prefix> [--add-product <key>] [--remove-product <key>]
                  [--add-project <slug>] [--remove-project <slug>]
                                   add products or projects to a limited key,
                                   or take them off, and print its new scope;
                                   each flag repeats, and one is required
  trail key list                   list every key's prefix, bot, times and scope
  trail key revoke <prefix>        revoke a key by its prefix or the full key
                                   and list the webhooks recording it, and
                                   those recording no key once the bot has no
                                   live key left, or, for an activity webhook,
                                   none with the read action
  trail products owners            list each product's current owner bot, or none
  trail products set-owner <key> <bot-id-label-or-name>
                                   make a bot the product's owner: it adds
                                   todos, accepts issues from triage and
                                   cancels any item
  trail products set-repo <key> <url>
                                   set the product's GitHub repository,
                                   https://github.com/<owner>/<name>

  --label <agent-id>  the bot's id in the system that runs it, unique among bots
  --products <keys>   scope: limit the key to these products, like ATL,BTA
  --projects <slugs>  scope: limit the key to these projects, like recon, and
                      their items in whichever product they live in
  --actions <actions> scope: limit the key to these of read, issues, comments,
                      status_updates and admin, like read,issues,comments
  --key-only          print only the key on stdout; the rest goes to stderr
  --clear             bot title, bot label: remove it instead of setting one
  --add-product <key>, --remove-product <key>, --add-project <slug>,
  --remove-project <slug>
                      key scope: the products and projects to add or take off;
                      a key left with neither is refused, as is adding to a
                      key that reaches everything

  <scope> is --products, --projects, --actions or any of them. A key with both
  --products and --projects reaches what either names; with neither it
  reaches every product; without --actions it has every action.
`;

const options = {
  help: { type: "boolean", short: "h" },
  label: { type: "string" },
  products: { type: "string" },
  projects: { type: "string" },
  actions: { type: "string" },
  "key-only": { type: "boolean" },
  clear: { type: "boolean" },
  "add-product": { type: "string", multiple: true },
  "remove-product": { type: "string", multiple: true },
  "add-project": { type: "string", multiple: true },
  "remove-project": { type: "string", multiple: true },
} as const;

type Flags = {
  label?: string;
  products?: string;
  projects?: string;
  actions?: string;
  "key-only"?: boolean;
  clear?: boolean;
  "add-product"?: string[];
  "remove-product"?: string[];
  "add-project"?: string[];
  "remove-project"?: string[];
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

/** "all products" only on an unrestricted key; `-` on a key limited to projects alone. */
const productsCell = (scope: KeyScopeView) =>
  scope.products === null ? "all products" : scope.products.join(",") || "-";
const projectsCell = (scope: KeyScopeView) => scope.projects?.join(",") || "-";
const actionsCell = (scope: KeyScopeView) =>
  scope.actions?.join(",") ?? "all actions";

/** `scope  products ATL; projects recon; all actions`, naming only the lists the key has. */
function scopeLine(scope: KeyScopeView): string {
  const reach =
    scope.products === null
      ? ["all products"]
      : [
          ...(scope.products.length > 0
            ? [`products ${productsCell(scope)}`]
            : []),
          ...(scope.projects?.length
            ? [`projects ${projectsCell(scope)}`]
            : []),
        ];
  const actions = scope.actions
    ? `actions ${actionsCell(scope)}`
    : actionsCell(scope);
  return `scope  ${[...reach, actions].join("; ")}\n`;
}

const isUnscoped = (scope: KeyScopeView) =>
  scope.products === null && scope.actions === null;

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
  const scope =
    listed && !isUnscoped(listed.scope) ? scopeLine(listed.scope) : "";
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

const listFlagExample = {
  products: "ATL,BTA",
  projects: "recon,launch-q4",
  actions: "read,issues",
};

/** The comma-separated value of a list flag; a blank entry is refused here, before the database opens. */
function listFlag(
  flag: keyof typeof listFlagExample,
  value: string | undefined,
): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => item === "")) {
    throw new UsageError(
      `--${flag} takes a comma-separated list with no blank entries, like --${flag}=${listFlagExample[flag]}; leave it out for no limit`,
    );
  }
  return items;
}

function scopeFlags(flags: Flags): KeyScopeInput {
  const products = listFlag("products", flags.products);
  const projects = listFlag("projects", flags.projects);
  const actions = listFlag("actions", flags.actions);
  return {
    ...(products && { products }),
    ...(projects && { projects }),
    ...(actions && { actions }),
  };
}

/**
 * Refuses product keys passed as project slugs, naming the flag that takes
 * them; --projects was once an alias of --products. Slugs are lowercase, so
 * an entry is a product key when, upper-cased, a product has it and no project
 * has it as its slug.
 */
function refuseProductKeys(
  db: Db,
  flag: string,
  productFlag: string,
  slugs: readonly string[] | undefined,
): void {
  if (!slugs?.length) return;
  const productKeys = new Set(listProductOwners(db).map((p) => p.key));
  const projectSlugs = new Set(
    db
      .select({ slug: project.slug })
      .from(project)
      .where(inArray(project.slug, [...slugs]))
      .all()
      .map((p) => p.slug),
  );
  const keys = [
    ...new Set(
      slugs
        .filter((s) => !projectSlugs.has(s))
        .map((s) => s.toUpperCase())
        .filter((k) => productKeys.has(k)),
    ),
  ];
  if (keys.length > 0) {
    throw new UsageError(
      `${flag} takes project slugs; ${andList(keys)} ${keys.length === 1 ? "is a product key" : "are product keys"}: pass ${keys.length === 1 ? "it" : "them"} with ${productFlag}`,
    );
  }
}

const botCreate: Command<{
  name: string;
  label?: string;
  scope: KeyScopeInput;
  keyOnly: boolean;
}> = {
  flags: ["label", "products", "projects", "actions", "key-only"],
  parse: (args, flags) => ({
    name: oneArg(args, "name"),
    label: flags.label,
    scope: scopeFlags(flags),
    keyOnly: flags["key-only"] === true,
  }),
  run(db, { name, label, scope, keyOnly }, io) {
    refuseProductKeys(db, "--projects", "--products", scope.projects);
    printKey(db, io, createBot(db, name, { label, scope }), keyOnly);
  },
};

const keyCreate: Command<{
  bot: string;
  scope: KeyScopeInput;
  keyOnly: boolean;
}> = {
  flags: ["products", "projects", "actions", "key-only"],
  parse: (args, flags) => ({
    bot: oneArg(args, "bot-id-or-label"),
    scope: scopeFlags(flags),
    keyOnly: flags["key-only"] === true,
  }),
  run(db, { bot, scope, keyOnly }, io) {
    refuseProductKeys(db, "--projects", "--products", scope.projects);
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
        "products",
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
        productsCell(k.scope),
        projectsCell(k.scope),
        actionsCell(k.scope),
      ]),
    ];
    printTable(io, rows);
  },
};

// a bare prefix, or anything starting `trail_<prefix>` — the full key or a truncated paste of it
const prefixPattern = /^(?:trail_)?([0-9a-f]{8})(?:_|$)/;

function prefixArg(args: readonly string[]): string {
  const prefix = prefixPattern.exec(oneArg(args, "prefix"))?.[1];
  if (prefix === undefined) {
    throw new UsageError(
      "<prefix> must be 8 hex characters, or a key starting trail_<prefix>_",
    );
  }
  return prefix;
}

const keyRevoke: Command<string> = {
  flags: [],
  parse: prefixArg,
  run(db, prefix, io) {
    const revoked = revokeKey(db, prefix);
    const { actorId, revokedAt, stopped } = revoked;
    io.stdout.write(
      `revoked trail_${prefix} (actor ${actorId}) at ${revokedAt.toISOString()}\n`,
    );
    if (stopped.length === 0) return;
    // the origin only: a webhook URL's path or query may carry the receiver's secret
    for (const hook of stopped) {
      io.stdout.write(
        `stopped webhook ${hook.id} (${hook.kind}) to ${new URL(hook.url).origin}\n`,
      );
    }
    const activityStopped = stopped.some((hook) => hook.kind === "activity");
    if (!revoked.liveKeysLeft) {
      io.stderr.write(
        `trail: this bot has no live key left: mint one first with \`trail key create ${revoked.label ?? actorId}${scopeFlagsOf(revoked.scope)}\`\n`,
      );
    } else if (!revoked.liveKeyCanRead && activityStopped) {
      // update_webhook and rotate_webhook_secret refuse every remaining key on an activity webhook
      io.stderr.write(
        "trail: none of this bot's live keys has the read action, and moving an activity webhook needs one\n",
      );
    }
    io.stderr.write(
      `trail: to move a webhook to another key, call update_webhook (PATCH /api/v1/webhooks/{id}) or rotate_webhook_secret with that key${activityStopped ? ", which needs the read action for an activity webhook" : ""} (the key checked becomes the one that last changed the webhook)\n`,
    );
  },
};

/** `scope` as the `key create` flags that mint it, each led by a space; none for an unrestricted key with every action. */
function scopeFlagsOf(scope: KeyScopeView): string {
  return [
    scope.products?.length && `--products ${scope.products.join(",")}`,
    scope.projects?.length && `--projects ${scope.projects.join(",")}`,
    scope.actions && `--actions ${scope.actions.join(",")}`,
  ]
    .filter(Boolean)
    .map((flag) => ` ${flag}`)
    .join("");
}

const scopeEditFlags = {
  "add-product": "addProducts",
  "remove-product": "removeProducts",
  "add-project": "addProjects",
  "remove-project": "removeProjects",
} as const satisfies Partial<Record<keyof Flags, keyof KeyScopeEdit>>;

const keyScope: Command<{ prefix: string; edit: KeyScopeEdit }> = {
  flags: Object.keys(scopeEditFlags) as (keyof typeof scopeEditFlags)[],
  parse(args, flags) {
    const prefix = prefixArg(args);
    const edit: KeyScopeEdit = {};
    for (const [flag, field] of Object.entries(scopeEditFlags)) {
      const values = flags[flag as keyof typeof scopeEditFlags];
      if (values === undefined) continue;
      if (values.some((v) => v.trim() === "")) {
        throw new UsageError(`--${flag} takes a non-blank value`);
      }
      edit[field] = values.map((v) => v.trim());
    }
    if (Object.keys(edit).length === 0) {
      throw new UsageError(
        "'key scope' needs --add-product, --remove-product, --add-project or --remove-project",
      );
    }
    return { prefix, edit };
  },
  run(db, { prefix, edit }, io) {
    refuseProductKeys(db, "--add-project", "--add-product", edit.addProjects);
    refuseProductKeys(
      db,
      "--remove-project",
      "--remove-product",
      edit.removeProjects,
    );
    const before = listKeys(db).find(
      (k) => k.prefix === prefix && k.revokedAt === null,
    )?.scope;
    let after: KeyScopeView;
    try {
      after = editKeyScope(db, prefix, edit);
    } catch (e) {
      const adds = Boolean(edit.addProducts || edit.addProjects);
      // with no adds, or on an unrestricted key, the refusal is the key's state, not the values sent: exit 1
      if (
        e instanceof ValidationError &&
        (!adds || (before !== undefined && before.products === null))
      ) {
        throw new Error(e.message);
      }
      throw e;
    }
    io.stdout.write(scopeLine(after));
    if (JSON.stringify(after) === JSON.stringify(before)) {
      io.stderr.write(
        "trail: nothing changed: the key already reaches what was added and not what was removed\n",
      );
    }
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

const botLabel: Command<{ bot: string; label: string | null }> = {
  flags: ["clear"],
  parse(args, flags) {
    if (args.length === 0)
      throw new UsageError("missing <bot-id-label-or-name>");
    if (args.length > 2) {
      throw new UsageError(
        `expected <bot-id-label-or-name> <agent-id>, got ${args.length} arguments; quote a value containing spaces`,
      );
    }
    const [bot, label] = args as [string, string | undefined];
    if (flags.clear) {
      if (label !== undefined) {
        throw new UsageError("'bot label --clear' takes no <agent-id>");
      }
      return { bot, label: null };
    }
    if (label === undefined) {
      throw new UsageError("missing <agent-id>, or --clear to remove it");
    }
    return { bot, label };
  },
  run(db, { bot, label }, io) {
    const set = setBotLabel(db, bot, label);
    io.stdout.write(
      `actor  ${set.id}\nname   ${set.name}\nfrom   ${set.oldLabel ?? "-"}\nto     ${set.newLabel ?? "-"}\n`,
    );
  },
};

/** Rows as columns padded to their widest cell, the last left unpadded. */
function printTable(io: CliIo, rows: string[][]): void {
  const widths = rows[0]?.map((_, i) =>
    Math.max(...rows.map((r) => (r[i] as string).length)),
  ) as number[];
  for (const row of rows) {
    const cells = row.map((cell, i) =>
      i === row.length - 1 ? cell : cell.padEnd(widths[i] as number),
    );
    io.stdout.write(`${cells.join("  ")}\n`);
  }
}

const productsOwners: Command<null> = {
  flags: [],
  parse(args) {
    if (args.length > 0) {
      throw new UsageError("'products owners' takes no arguments");
    }
    return null;
  },
  run(db, _, io) {
    printTable(io, [
      ["product", "owner"],
      ...listProductOwners(db).map((r) => [r.key, r.owner ?? "none"]),
    ]);
  },
};

function printChange(io: CliIo, change: ProductChange): void {
  io.stdout.write(
    `product  ${change.key}\nfrom     ${change.from ?? "-"}\nto       ${change.to}\n`,
  );
}

function twoArgs(
  args: readonly string[],
  first: string,
  second: string,
): [string, string] {
  if (args.length === 0) throw new UsageError(`missing <${first}>`);
  if (args.length === 1) throw new UsageError(`missing <${second}>`);
  if (args.length > 2) {
    throw new UsageError(
      `expected <${first}> <${second}>, got ${args.length} arguments; quote a value containing spaces`,
    );
  }
  return [args[0] as string, args[1] as string];
}

const productsSetOwner: Command<[string, string]> = {
  flags: [],
  parse: (args) => twoArgs(args, "key", "bot-id-label-or-name"),
  run(db, [key, bot], io) {
    printChange(io, setProductOwner(db, key, bot));
  },
};

const productsSetRepo: Command<[string, string]> = {
  flags: [],
  parse: (args) => twoArgs(args, "key", "url"),
  run(db, [key, url], io) {
    printChange(io, setProductRepo(db, key, url));
  },
};

// method syntax in Command keeps run() bivariant, so each command keeps its own input type
const commands: Record<string, Command<unknown> | undefined> = {
  "bot create": botCreate,
  "bot rename": botRename,
  "bot title": botTitle,
  "bot label": botLabel,
  "key create": keyCreate,
  "key list": keyList,
  "key revoke": keyRevoke,
  "key scope": keyScope,
  "products owners": productsOwners,
  "products set-owner": productsSetOwner,
  "products set-repo": productsSetRepo,
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
