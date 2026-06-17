import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  outputDir: './test-results/package-d-artifacts',
  reporter: [['list'], ['html', { outputFolder: './playwright-report/package-d', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8776',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'python -m src.local_api.sheet_mapping_server',
    cwd: repoRoot,
    env: {
      ...process.env,
      INVOICELENS_SERVE_UI: '1',
      INVOICELENS_LOCAL_API_HOST: '127.0.0.1',
      INVOICELENS_LOCAL_API_PORT: '8776',
      PYTHONUTF8: '1',
    },
    url: 'http://127.0.0.1:8776/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
