import { defineConfig, devices } from '@playwright/test';

/**
 * Browser-level suite.
 *
 * 11-testing-architecture.md §6. This exists for the assertions jsdom cannot make honestly:
 * computed colour contrast, landmark structure on a real page, and whether a focus ring is
 * actually painted. Component behaviour is covered by the 97 tests in @growth-os/ui.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: process.env['CI'] === 'true',
  retries: process.env['CI'] === 'true' ? 1 : 0,
  reporter: process.env['CI'] === 'true' ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Pre-provisioned in this environment; never download at test time
        // (00-assessment.md §2).
        launchOptions: { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] },
      },
    },
  ],
});
