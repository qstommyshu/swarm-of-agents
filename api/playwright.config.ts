import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { defineConfig, devices } from "@playwright/test";

const apiDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(apiDir, "..");
dotenv.config({ path: path.join(rootDir, ".env"), override: false });
dotenv.config({ path: path.join(apiDir, ".env"), override: false });

const apiPort = 3001;
const webPort = 3100;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const apiAuthToken = process.env.ATLAS_E2E_API_AUTH_TOKEN ?? "atlas-e2e-local-token";

export default defineConfig({
  testDir: "./e2e",
  timeout: 240_000,
  expect: {
    timeout: 45_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: webUrl,
    extraHTTPHeaders: {
      Authorization: `Bearer ${apiAuthToken}`,
    },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npm run dev",
      cwd: ".",
      url: `${apiUrl}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(apiPort),
        ATLAS_WORKSPACE_ID: "e2e-handoff",
        ATLAS_API_AUTH_TOKEN: apiAuthToken,
        CORS_ORIGIN: webUrl,
        DATABASE_URL: "file:./.atlas/e2e/atlas-handoff.db",
        LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      },
    },
    {
      command: "npm run build && npm run start -- --port 3100 --hostname 127.0.0.1",
      cwd: "../web",
      url: webUrl,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_PUBLIC_ATLAS_API_URL: apiUrl,
        NEXT_PUBLIC_ATLAS_API_AUTH_TOKEN: apiAuthToken,
      },
    },
  ],
});
