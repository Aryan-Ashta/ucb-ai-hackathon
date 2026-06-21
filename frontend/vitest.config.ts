/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // React 17+ automatic JSX runtime — no need to `import React` in test files
  // or component files (the existing app/ files don't import React either).
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["__tests__/**/*.test.{ts,tsx}", "**/*.test.{ts,tsx}"],
    // React's act() helper only ships in development builds. Set
    // NODE_ENV=test so vitest resolves react/index.js (dev) rather than
    // react.production.min.js — otherwise every renderHook call crashes.
    env: {
      NODE_ENV: "test",
    },
    // The Next.js app directory is mostly JSX/TSX components that need a
    // heavy mock surface to test; we focus tests on lib/ helpers + the
    // useRecorder hook + the dashboard components + the quiz panels for now.
    // Add more here as coverage grows.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "lib/**",
        "app/quiz/[id]/*.ts",
        "app/quiz/[id]/*.tsx",
        "app/dashboard/*.tsx",
      ],
      exclude: ["lib/mock.ts", "**/*.d.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
