import { defineConfig, devices } from "@playwright/test";

// End-to-end tests for DrumCoach. They drive the app through the loopback audio
// path (?loopback=1) so the full mic → onset → classify → staff pipeline runs on
// synth audio with no real microphone.
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.e2e.js",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://localhost:3080",
    // Let the AudioContext run without a user gesture in headless.
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Port 3080 (not the default 3000) to avoid clashing with other local apps.
    command: "PORT=3080 node server.js",
    url: "http://localhost:3080/healthz",
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
