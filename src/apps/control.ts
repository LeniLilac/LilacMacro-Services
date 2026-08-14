import { buildControlServer } from './control-server.js';
import { composeControlServices } from './composition.js';

const services = composeControlServices();
await services.commandService.republish();
const app = await buildControlServer(services);

const shutdown = async () => {
  await app.close();
  await services.pool.end();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: services.config.HOST, port: services.config.PORT });
