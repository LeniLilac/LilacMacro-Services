import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { renderPublicHome } from '../src/apps/public-page-renderer.js';
import { defaultControlState } from '../src/infrastructure/memory-repositories.js';
import { Ed25519SnapshotSigner } from '../src/infrastructure/snapshot-signer.js';

const template = [
  '<a href="__LILAC_DOWNLOAD_URL__">Download</a>',
  '<a href="__LILAC_DISCORD_INSTALL_URL__">Install Discord app</a>',
  '<div data-state="__LILAC_STATUS_STATE__">__LILAC_STATUS_TEXT__</div>',
].join('');

test('public home renders direct installer and status from a fresh signed snapshot', async () => {
  const pair = generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const signer = new Ed25519SnapshotSigner(privateKey, publicKey, 'test-1');
  const now = new Date('2026-08-14T12:00:00.000Z');
  const state = defaultControlState();
  state.release = {
    version: '1.2.3',
    pageUrl: 'https://github.com/LeniLilac/LilacMacro/releases/tag/v1.2.3',
    installerUrl:
      'https://github.com/LeniLilac/LilacMacro/releases/download/v1.2.3/LilacMacro-Setup.exe',
    publishedAt: now.toISOString(),
  };
  state.game.observedPublic = true;

  const html = renderPublicHome(
    template,
    await signer.sign(state, now),
    { 'test-1': publicKey },
    '123456789012345678',
    now,
    0,
  );

  assert.match(html, /releases\/download\/v1\.2\.3\/LilacMacro-Setup\.exe/);
  assert.match(html, /discord\.com\/oauth2\/authorize\?client_id=123456789012345678/);
  assert.match(html, /data-state="available"/);
  assert.match(html, /Game available/);
  assert.doesNotMatch(html, /__LILAC_/);
});

test('public home falls back safely when a snapshot cannot be trusted', () => {
  const html = renderPublicHome(
    template,
    null,
    {},
    '123456789012345678',
    new Date('2026-08-14T12:00:00.000Z'),
    0,
  );

  assert.match(html, /releases\/latest/);
  assert.match(html, /data-state="unknown"/);
  assert.match(html, /Status temporarily unavailable/);
  assert.doesNotMatch(html, /__LILAC_/);
});

test('public home rejects an unsafe Discord client ID', () => {
  assert.throws(() => renderPublicHome(template, null, {}, '1&scope=identify', new Date(), 0));
});
