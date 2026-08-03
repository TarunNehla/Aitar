import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApi } from "./api.js";
import { closeDatabase } from "./db/client.js";
import { agentWorker } from "./runtime/agent-runner.js";
import { config } from "./config.js";

const app = createApi();
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const clientDirectory = join(currentDirectory, "../client");

if (config.NODE_ENV === "production" && existsSync(clientDirectory)) {
  app.use(express.static(clientDirectory));
  app.get("*splat", (_request, response) => response.sendFile(join(clientDirectory, "index.html")));
}

const server = app.listen(config.PORT, async () => {
  await agentWorker.start();
  console.log(`Cloud Agents V0 is running on http://localhost:${config.PORT}`);
});

async function shutdown() {
  agentWorker.stop();
  server.close();
  await closeDatabase();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
