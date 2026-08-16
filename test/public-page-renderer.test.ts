import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderPublicHome } from '../src/apps/public-page-renderer.js';
import { defaultControlState } from '../src/infrastructure/memory-repositories.js';
import { Ed25519SnapshotSigner } from '../src/infrastructure/snapshot-signer.js';

const template = [
  '<a class="button__LILAC_RELEASE_CLASS__" href="__LILAC_DOWNLOAD_URL__"__LILAC_RELEASE_LINK_STATE__>',
  '__LILAC_RELEASE_ACTION_LABEL__ __LILAC_RELEASE_SHORT_LABEL__</a>',
  '<p>__LILAC_RELEASE_STATUS__</p>',
  '<a href="__LILAC_DISCORD_INSTALL_URL__">Install Discord app</a>',
].join('');

test('public home renders the reviewable release page from a fresh signed snapshot', async () => {
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

  assert.match(html, /releases\/tag\/v1\.2\.3/);
  assert.doesNotMatch(html, /releases\/download\/v1\.2\.3\/LilacMacro-Setup\.exe/);
  assert.match(html, /discord\.com\/oauth2\/authorize\?client_id=123456789012345678/);
  assert.match(html, /Open verified GitHub release Verified release/);
  assert.doesNotMatch(html, /aria-disabled/);
  assert.doesNotMatch(html, /__LILAC_/);
});

test('public home disables release actions when a snapshot cannot be trusted', () => {
  const html = renderPublicHome(
    template,
    null,
    {},
    '123456789012345678',
    new Date('2026-08-14T12:00:00.000Z'),
    0,
  );

  assert.match(html, /href="#release-status" aria-disabled="true" tabindex="-1"/);
  assert.match(html, /No verified release available Release unavailable/);
  assert.match(html, /Downloads are paused/);
  assert.doesNotMatch(html, /__LILAC_/);
});

test('public home rejects an unsafe Discord client ID', () => {
  assert.throws(() => renderPublicHome(template, null, {}, '1&scope=identify', new Date(), 0));
});

test('legal pages publish direct contact and the implemented privacy controls', async () => {
  const [privacy, terms] = await Promise.all([
    readFile('public/privacy.html', 'utf8'),
    readFile('public/terms.html', 'utf8'),
  ]);

  for (const page of [privacy, terms]) {
    assert.match(page, /mailto:lilithlilac000@gmail\.com/);
    assert.doesNotMatch(page, /private contact channel|contact@vanguardvalues\.gg/);
  }
  assert.match(privacy, /Online features and\s+product telemetry are initially shown on/);
  assert.match(privacy, /Telemetry becomes eligible for scheduled deletion after 90 days/);
  assert.match(privacy, /Access to routine archives expires after 72\s+hours/);
  assert.match(privacy, /separate local cleanup setting can keep\s+only the 20 newest/);
  assert.match(terms, /PolyForm Noncommercial\s+License 1\.0\.0/);
  assert.match(terms, /href="\/privacy">Privacy Policy<\/a>/);
});
