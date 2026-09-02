import { defineConfig } from '@playwright/test';

const port = 18_087;

export default defineConfig({
  fullyParallel: false,
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  reporter: process.env.CI ? 'github' : 'list',
  testDir: './test/browser',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    reuseExistingServer: false,
    timeout: 30_000,
    url: `http://127.0.0.1:${port}/test/browser/`,
  },
  workers: 1,
});
