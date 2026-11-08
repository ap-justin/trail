// `pnpm db:generate [drizzle-kit generate flags]`: drizzle-kit generate, then STRICT on
// every CREATE TABLE it emitted — drizzle's schema builder has no way to say STRICT.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const folder = fileURLToPath(new URL("./migrations", import.meta.url));

const kit = spawnSync("drizzle-kit", ["generate", ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (kit.status !== 0) process.exit(kit.status ?? 1);

const STATEMENT_BREAK = "--> statement-breakpoint";

for (const file of readdirSync(folder).filter((f) => f.endsWith(".sql"))) {
  const path = join(folder, file);
  const before = readFileSync(path, "utf8");
  const after = before
    .split(STATEMENT_BREAK)
    .map((statement) =>
      /^\s*CREATE TABLE/i.test(statement) &&
      !/\)\s*STRICT;?\s*$/i.test(statement)
        ? statement.replace(/\)(;?\s*)$/, ") STRICT$1")
        : statement,
    )
    .join(STATEMENT_BREAK);
  if (after !== before) writeFileSync(path, after);
}
