import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      // Tests run against TypeScript sources directly; no build step needed.
      "@roblox-studio-mcp/shared": new URL("./shared/src/index.ts", import.meta.url).pathname,
    },
  },
});
