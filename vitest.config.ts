import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [".cache/**", "dist/**", "node_modules/**"],
    testTimeout: 30_000,
  },
});

