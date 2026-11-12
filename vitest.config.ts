import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server",
          include: ["src/{server,shared}/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        // routeTree.gen.ts is committed, so the router plugin is not needed here
        resolve: { alias: { "@": path.resolve("src/web") } },
        test: {
          name: "web",
          include: ["src/web/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          // a findBy may wait 5s (src/web/test/setup.ts), so a test needs more than the 5s default
          testTimeout: 15000,
          setupFiles: ["src/web/test/setup.ts"],
        },
      },
    ],
  },
});
