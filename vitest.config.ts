import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      DATABASE_URL: "postgresql://test:test@localhost/test",
      WORKSPACE_ROOT: "/tmp/cloud-agents-tests",
    },
  },
});
