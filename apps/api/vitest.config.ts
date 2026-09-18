import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Found live: without this, `npm run build` compiles test files
    // into dist/*.test.js too, and vitest's default glob picks up BOTH
    // the source .ts tests and their compiled .js copies — every test
    // silently ran twice (98 "passed" instead of the real 49). Not a
    // correctness bug (both copies pass or fail together), but wrong
    // and wasteful, and would mask a real divergence between source and
    // build output if one ever crept in.
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
