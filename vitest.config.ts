import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // test/e2e is Playwright's; it drives a real browser and a real CLI process.
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
    // Node's experimental global `localStorage` shadows the one happy-dom
    // installs on the test environment, so `localStorage` in a test resolves
    // to Node's (unusable without --localstorage-file) instead of the DOM's.
    env: { NODE_OPTIONS: '--no-experimental-webstorage' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Only src/ is exercised by this run; client/ has no test coverage of its own yet,
      // and test/e2e's Playwright specs aren't part of this process.
      include: ['src/**'],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
      },
    },
  },
});
