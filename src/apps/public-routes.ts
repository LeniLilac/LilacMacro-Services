import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from '../domain/clock.js';
import type { ControlRepository } from '../domain/ports.js';
import type { ApiServiceConfig } from '../infrastructure/config.js';
import { renderPublicHome } from './public-page-renderer.js';

interface PublicRouteDependencies {
  config: ApiServiceConfig;
  clock: Clock;
  controlRepository: ControlRepository;
}

export async function registerPublicRoutes(
  app: FastifyInstance,
  dependencies: PublicRouteDependencies,
  publicRoot: string,
): Promise<void> {
  const fs = await import('node:fs/promises');
  const [homeTemplate, downloadsTemplate] = await Promise.all([
    fs.readFile(path.join(publicRoot, 'index.html'), 'utf8'),
    fs.readFile(path.join(publicRoot, 'downloads.html'), 'utf8'),
  ]);
  const publicKeys = {
    [dependencies.config.CONTROL_SIGNING_KEY_ID]:
      dependencies.config.CONTROL_SIGNING_PUBLIC_KEY_BASE64,
  };
  const renderPage = (
    template: string,
    snapshot: Parameters<typeof renderPublicHome>[1],
    revision: number,
  ) =>
    renderPublicHome(
      template,
      snapshot,
      publicKeys,
      dependencies.config.DISCORD_BOT_CLIENT_ID,
      dependencies.clock.now(),
      revision,
    );
  const publicPage =
    (template: string) => async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const [state, snapshot] = await Promise.all([
          dependencies.controlRepository.readState(),
          dependencies.controlRepository.readPublished(),
        ]);
        return reply.type('text/html').send(renderPage(template, snapshot, state.revision));
      } catch {
        return reply.type('text/html').send(renderPage(template, null, 0));
      }
    };
  app.get('/', publicPage(homeTemplate));
  app.get('/downloads', publicPage(downloadsTemplate));
  app.get('/privacy', async (_request, reply) =>
    reply.type('text/html').sendFile('privacy.html', publicRoot),
  );
  app.get('/terms', async (_request, reply) =>
    reply.type('text/html').sendFile('terms.html', publicRoot),
  );
}
