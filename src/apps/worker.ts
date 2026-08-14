import { setTimeout as delay } from 'node:timers/promises';
import { composeWorkerServices } from './composition.js';
import { ServiceHeartbeat } from './service-heartbeat.js';

const services = composeWorkerServices();
const controller = new AbortController();
let lastMaintenanceSuccess = 0;
let lastRepublishSuccess = 0;
let diagnosticActiveSince = 0;
const heartbeat = new ServiceHeartbeat('/tmp/lilacmacro-worker-ready', () => {
  const now = Date.now();
  const maintenanceReady =
    now - lastMaintenanceSuccess < 3 * 60_000 ||
    (diagnosticActiveSince > 0 && now - diagnosticActiveSince < 2 * 60 * 60_000 + 60_000);
  return maintenanceReady && now - lastRepublishSuccess < 7 * 60_000;
});

process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
heartbeat.start();

await Promise.all([diagnosticLoop(), controlLoop()]);
await heartbeat.stop();
await services.pool.end();

async function diagnosticLoop(): Promise<void> {
  while (!controller.signal.aborted) {
    diagnosticActiveSince = Date.now();
    let succeeded = true;
    try {
      const verified = await services.diagnosticService.verifyPending(4, controller.signal);
      if (verified) console.log(JSON.stringify({ event: 'diagnostic_verification', verified }));
    } catch (error) {
      succeeded = false;
      logError('verification_worker_error', error);
    }
    if (controller.signal.aborted) break;
    try {
      const removed = await services.diagnosticService.cleanup(100, controller.signal);
      if (removed) console.log(JSON.stringify({ event: 'diagnostic_cleanup', removed }));
    } catch (error) {
      succeeded = false;
      logError('diagnostic_cleanup_error', error);
    }
    if (controller.signal.aborted) break;
    try {
      const aborted = await services.diagnosticService.reconcileMultipartOrphans(
        100,
        controller.signal,
      );
      if (aborted) console.log(JSON.stringify({ event: 'multipart_orphans_aborted', aborted }));
    } catch (error) {
      succeeded = false;
      logError('multipart_reconciliation_error', error);
    }
    diagnosticActiveSince = 0;
    if (succeeded) lastMaintenanceSuccess = Date.now();
    await heartbeat.refresh();
    await wait(60_000);
  }
}

async function controlLoop(): Promise<void> {
  while (!controller.signal.aborted) {
    try {
      await services.operationalSync.syncRelease();
    } catch (error) {
      logError('release_sync_error', error);
    }
    if (controller.signal.aborted) break;
    try {
      await services.operationalSync.syncPlayability();
    } catch (error) {
      logError('playability_sync_error', error);
    }
    if (controller.signal.aborted) break;
    try {
      await services.control.republish();
      lastRepublishSuccess = Date.now();
    } catch (error) {
      logError('republish_error', error);
    }
    await heartbeat.refresh();
    await wait(5 * 60_000);
  }
}

async function wait(milliseconds: number): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
}

function logError(event: string, error: unknown): void {
  console.error(JSON.stringify({ event, message: safeMessage(error) }));
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
