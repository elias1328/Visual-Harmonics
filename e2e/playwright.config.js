// Cross-browser smoke suite. Run from this folder: npx playwright test [--project=firefox]
const { defineConfig, devices } = require('@playwright/test');
// VH_PORT / VH_ROOT: serve another checkout (e.g. to compare against an older tree).
const PORT = +process.env.VH_PORT || 8971;
const ROOT = process.env.VH_ROOT || '..';

module.exports = defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 1,   // python -m http.server has a listen backlog of 5; on Windows extra connections are refused
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `python -m http.server ${PORT} --bind 127.0.0.1`,
    cwd: ROOT,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
