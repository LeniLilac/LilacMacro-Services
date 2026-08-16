import type { SignedControlSnapshot } from '../contracts/control-snapshot.js';
import { parseVerifyAndValidateSnapshot } from '../infrastructure/snapshot-signer.js';

const releasesFallback = '#release-status';

export function renderPublicHome(
  template: string,
  snapshot: SignedControlSnapshot | null,
  publicKeys: Readonly<Record<string, string>>,
  discordClientId: string,
  now: Date,
  minimumRevision: number,
): string {
  let downloadUrl = releasesFallback;
  let releaseAvailable = false;

  try {
    if (!snapshot) throw new Error('Control snapshot was unavailable.');
    const verified = parseVerifyAndValidateSnapshot(snapshot, publicKeys, now, minimumRevision);
    if (verified.payload.release) {
      downloadUrl = verified.payload.release.pageUrl;
      releaseAvailable = true;
    }
  } catch {
    // The public page must remain useful without trusting stale or malformed control data.
  }

  return template
    .replaceAll('__LILAC_DOWNLOAD_URL__', escapeAttribute(downloadUrl))
    .replaceAll(
      '__LILAC_RELEASE_LINK_STATE__',
      releaseAvailable ? '' : ' aria-disabled="true" tabindex="-1"',
    )
    .replaceAll('__LILAC_RELEASE_CLASS__', releaseAvailable ? '' : ' release-unavailable')
    .replaceAll(
      '__LILAC_RELEASE_ACTION_LABEL__',
      releaseAvailable ? 'Open verified GitHub release' : 'No verified release available',
    )
    .replaceAll(
      '__LILAC_RELEASE_SHORT_LABEL__',
      releaseAvailable ? 'Verified release' : 'Release unavailable',
    )
    .replaceAll(
      '__LILAC_RELEASE_STATUS__',
      releaseAvailable
        ? 'The latest release passed LilacMacro signature and asset verification.'
        : 'Downloads are paused because LilacMacro could not verify a current release.',
    )
    .replaceAll('__LILAC_DISCORD_INSTALL_URL__', discordInstallUrl(discordClientId));
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
