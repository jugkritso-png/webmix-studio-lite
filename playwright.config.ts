import { defineConfig, devices } from '@playwright/test';

const media = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];

export default defineConfig({
  testDir: 'tests',
  timeout: 45_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    permissions: ['camera', 'microphone'],
    launchOptions: { args: media },
    acceptDownloads: true,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'], launchOptions: { args: media } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], permissions: ['camera', 'microphone'], launchOptions: { args: media } } },
  ],
  webServer: [
    { command: 'npx vite preview --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI },
    { command: 'node tests/support/mock-gateway.mjs', url: 'http://localhost:8090/stats', reuseExistingServer: !process.env.CI },
    { command: 'node tests/support/peer-server.mjs', url: 'http://localhost:9000/peerjs/id', reuseExistingServer: !process.env.CI },
  ],
});
