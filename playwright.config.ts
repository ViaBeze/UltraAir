import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir: './tests', fullyParallel: true, workers: 2, timeout: 60000,
 use: { baseURL: process.env.RYADOM_TEST_URL || 'http://127.0.0.1:4173', channel: 'chrome', headless: true, launchOptions: {args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']}, viewport: { width: 1440, height: 1024 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
 reporter: [['list']],
 webServer: process.env.RYADOM_TEST_URL ? undefined : { command: 'npm run dev -- --port 4173', url: 'http://127.0.0.1:4173', reuseExistingServer: true },
});
