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
  },
});
