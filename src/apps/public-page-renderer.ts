import type { SignedControlSnapshot } from '../contracts/control-snapshot.js';
import { parseVerifyAndValidateSnapshot } from '../infrastructure/snapshot-signer.js';

const releasesFallback = 'https://github.com/LeniLilac/LilacMacro/releases/latest';

export function renderPublicHome(
  template: string,
  snapshot: SignedControlSnapshot | null,
  publicKeys: Readonly<Record<string, string>>,
  discordClientId: string,
  now: Date,
  minimumRevision: number,
): string {
  let downloadUrl = releasesFallback;
  let status = 'Status temporarily unavailable · macro uses signed last-known-good data';
  let statusState: 'available' | 'unavailable' | 'unknown' = 'unknown';

  try {
    if (!snapshot) throw new Error('Control snapshot was unavailable.');
    const verified = parseVerifyAndValidateSnapshot(snapshot, publicKeys, now, minimumRevision);
    downloadUrl = verified.payload.release?.installerUrl ?? releasesFallback;
    if (verified.payload.game.available) {
      status = 'Game available · signed status current';
      statusState = 'available';
    } else {
      status = verified.payload.game.message ?? 'Game maintenance in progress';
      statusState = 'unavailable';
    }
  } catch {
    // The public page must remain useful without trusting stale or malformed control data.
  }

  return template
    .replaceAll('__LILAC_DOWNLOAD_URL__', escapeAttribute(downloadUrl))
    .replaceAll('__LILAC_DISCORD_INSTALL_URL__', discordInstallUrl(discordClientId))
    .replaceAll('__LILAC_STATUS_TEXT__', escapeText(status))
    .replaceAll('__LILAC_STATUS_STATE__', statusState);
}

function discordInstallUrl(clientId: string): string {
  if (!/^\d+$/.test(clientId)) throw new Error('Discord client ID was invalid.');
  return `https://discord.com/oauth2/authorize?client_id=${clientId}`;
}

function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeText(value);
}
