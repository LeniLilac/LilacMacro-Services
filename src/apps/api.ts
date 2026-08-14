import { buildApi } from './api-server.js';
import { composeApiServices } from './composition.js';

const services = composeApiServices();
const app = await buildApi(services);
await services.authStore.cleanupExpired(new Date());

let cleanupRunning = false;
const cleanupTimer = setInterval(async () => {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    await services.authStore.cleanupExpired(new Date());
  } catch (error) {
    app.log.error(
      { errorName: error instanceof Error ? error.name : 'UnknownError' },
      'auth cleanup',
    );
  } finally {
    cleanupRunning = false;
  }
}, 60_000);
cleanupTimer.unref();

const shutdown = async () => {
  clearInterval(cleanupTimer);
  await app.close();
  await services.pool.end();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: services.config.HOST, port: services.config.PORT });
