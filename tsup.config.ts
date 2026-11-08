import { cp } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server/index.ts"],
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
