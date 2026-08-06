import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    env: {
      DATABASE_URL: "postgresql://test:test@localhost/test",
      WORKSPACE_ROOT: "/tmp/cloud-agents-tests",
      APP_URL: "http://localhost:5173",
      BETTER_AUTH_SECRET: "test-better-auth-secret-value-000000000000",
      GOOGLE_CLIENT_ID: "test-google-client-id",
      GOOGLE_CLIENT_SECRET: "test-google-client-secret",
      GITHUB_CLIENT_ID: "test-github-client-id",
      GITHUB_CLIENT_SECRET: "test-github-client-secret",
      GITHUB_APP_ID: "1234",
      GITHUB_APP_SLUG: "cloud-agents-test",
      GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    },
    projects: [
      {
        extends: true,
        test: { name: "node", environment: "node", include: ["src/**/*.test.ts"] },
      },
      {
        extends: true,
        test: { name: "browser", environment: "jsdom", include: ["src/**/*.test.tsx"] },
      },
    ],
  },
});
