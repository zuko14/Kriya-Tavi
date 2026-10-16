import path from "node:path"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    include: ["tests/**/*.test.ts"],
    // Each database test file boots its own in-process Postgres
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
