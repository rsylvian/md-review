import { defineConfig, devices } from '@playwright/test';

// Defaults to the Chrome you already have installed, which avoids downloading a second
// browser (and works behind proxies that block Playwright's CDN). Set
// MD_REVIEW_CHANNEL=bundled to use Playwright's own chromium instead — that is what CI
// does, since a runner has no Chrome.
const channel = process.env.MD_REVIEW_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI === undefined ? 'list' : 'dot',
  use: { ...devices['Desktop Chrome'], ...(channel === 'bundled' ? {} : { channel }) },
});
