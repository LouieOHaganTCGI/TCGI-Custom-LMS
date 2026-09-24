import { loadConfig, type Config } from "./config.js";
import { createServices, type Services } from "./services.js";
import { buildAppServer } from "./web/app-server.js";
import { buildContentServer } from "./web/content-server.js";

export interface RunningLms {
  services: Services;
  stop(): Promise<void>;
}

/** Start the app origin, the content origin and (optionally) the in-process outbox worker. */
export async function startLms(config: Config, services = createServices(config)): Promise<RunningLms> {
  const app = await buildAppServer(services);
  const content = await buildContentServer(services);
  await app.listen({ host: config.HOST, port: config.APP_PORT });
  await content.listen({ host: config.HOST, port: config.CONTENT_PORT });
  let stopped = false;
  let loop: Promise<void> = Promise.resolve();
  if (config.RUN_WORKER) {
    loop = (async () => {
      while (!stopped) {
        const n = await services.dispatcher.runOnce(50).catch((e) => (app.log.error({ err: e }, "outbox dispatch failed"), 0));
        if (n === 0) await new Promise((r) => setTimeout(r, config.WORKER_POLL_MS));
      }
    })();
  }
  return {
    services,
    async stop() {
      stopped = true;
      await loop;
      await app.close();
      await content.close();
      await services.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  startLms(config)
    .then((lms) => {
      const shutdown = () => void lms.stop().then(() => process.exit(0));
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
