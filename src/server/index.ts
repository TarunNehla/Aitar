import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApi } from "./api.js";
import { closeDatabase } from "./db/client.js";
import { agentWorker } from "./runtime/agent-runner.js";
import { config } from "./config.js";
import { errorForLog, logger } from "./logger.js";
import { ensureAskpassHelper } from "./runtime/git-credentials.js";
import { environmentReaper } from "./runtime/environment-reaper.js";

const app = createApi();
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const clientDirectory = join(currentDirectory, "../client");

if (config.NODE_ENV === "production" && existsSync(clientDirectory)) {
  app.use(express.static(clientDirectory));
  app.get("*splat", (_request, response) => response.sendFile(join(clientDirectory, "index.html")));
}

const server = app.listen(config.PORT, () => {
  void ensureAskpassHelper()
    .then(() => agentWorker.start())
    .then(() => {
      environmentReaper.start();
      logger.info(
        {
          port: config.PORT,
          environment: config.NODE_ENV,
          maxActiveRuns: config.MAX_ACTIVE_RUNS,
          defaultModel: config.OPENROUTER_MODEL,
        },
        "Cloud Agents API started",
      );
    })
    .catch((error) => {
      logger.fatal({ error: errorForLog(error) }, "Agent worker failed to start");
      void shutdown("startup_failure", 1);
    });
});

let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, "Backend shutdown started");
  agentWorker.stop();
  environmentReaper.stop();
  server.close();
  try {
    await closeDatabase();
    logger.info("Backend shutdown completed");
  } catch (error) {
    logger.error({ error: errorForLog(error) }, "Database shutdown failed");
    exitCode = 1;
  }
  logger.flush();
  process.exit(exitCode);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("uncaughtException", (error) => {
  logger.fatal({ error: errorForLog(error) }, "Uncaught exception");
  void shutdown("uncaught_exception", 1);
});
process.once("unhandledRejection", (error) => {
  logger.fatal({ error: errorForLog(error) }, "Unhandled promise rejection");
  void shutdown("unhandled_rejection", 1);
});
