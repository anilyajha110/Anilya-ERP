import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Same fix as apps/api/vitest.config.ts — see that file's comment.
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
