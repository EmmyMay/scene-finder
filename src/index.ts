import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnvFile } from "./env.js";
import { createApp, startServer, type BackendServerOptions, type RunningBackendServer } from "./server.js";

export { createApp, startServer, type BackendServerOptions, type RunningBackendServer };
export * from "./types.js";
export * from "./jev-client.js";
export * from "./media.js";
export * from "./scene-grouping.js";

async function runCli(): Promise<void> {
  loadDotEnvFile();
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000) || 3000;
  const running = await startServer({ host, port });
  console.log(`Scene Finder backend listening on ${running.url}`);

  const shutdown = (): void => {
    void running.close().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const currentFilePath = fileURLToPath(import.meta.url);
const entryArg = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryArg && currentFilePath === entryArg) {
  void runCli();
}
