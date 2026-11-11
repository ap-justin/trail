import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // PORT from .env, as `pnpm dev` reads it; a variable already in the shell wins.
  // `||`: a blank `PORT=` loads as "" and would leave the proxy target without a port.
  const env = loadEnv(mode, process.cwd(), "");
  const api = `http://localhost:${env.PORT || 3000}`;
  return {
    root: "src/web",
    // the router plugin must precede react so it sees route files before JSX transforms
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        // defaults are ./src/routes relative to root, which is already src/web
        routesDirectory: "./routes",
        generatedRouteTree: "./routeTree.gen.ts",
        // tests sit beside their routes
        routeFileIgnorePattern: "\\.test\\.",
      }),
      react(),
      tailwindcss(),
    ],
    resolve: { alias: { "@": path.resolve("src/web") } },
    server: { proxy: { "/api": api, "/mcp": api } },
    build: {
      // beside tsup's output; tsup runs first because its `clean` empties dist
      outDir: "../../dist/web",
      emptyOutDir: true,
    },
  };
});
