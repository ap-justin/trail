import { cp } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  // cli.ts builds to dist/cli.js: the shipped bundle mints bot keys with plain node
  entry: ["src/server/index.ts", "src/server/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Native addon: loaded from node_modules at runtime, never inlined.
  external: ["better-sqlite3"],
  // migrate() in src/server/db/client.ts reads ./migrations beside the running module
  onSuccess: () =>
    cp("src/server/db/migrations", "dist/migrations", { recursive: true }),
});
