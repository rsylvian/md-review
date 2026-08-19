import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // test/e2e is Playwright's; it drives a real browser and a real CLI process.
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
  },
});
