import { spawn } from 'node:child_process';
import { CloudflareProvisioner } from '../src/infrastructure/cloudflare-provisioner.js';

const publicOrigin = required('PUBLIC_ORIGIN');
const publicHostname = new URL(publicOrigin).hostname;
const result = await new CloudflareProvisioner().provision({
  accountId: required('CLOUDFLARE_ACCOUNT_ID'),
  apiToken: required('CLOUDFLARE_API_TOKEN'),
  zoneName: process.env.CLOUDFLARE_ZONE_NAME ?? 'expeditions.gg',
  publicHostname,
  tunnelName: process.env.CLOUDFLARE_TUNNEL_NAME ?? 'lilacmacro-services-production',
});

await storeDopplerSecret('CLOUDFLARE_TUNNEL_TOKEN', result.tunnelToken);
await storeDopplerSecret('CLOUDFLARE_TUNNEL_ID', result.tunnelId);
console.error(`Cloudflare tunnel and DNS are configured for ${publicHostname}.`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function storeDopplerSecret(name: string, value: string): Promise<void> {
  if (!process.env.DOPPLER_TOKEN) throw new Error('DOPPLER_TOKEN is required.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('doppler', ['secrets', 'set', name, '--no-interactive', '--silent'], {
      stdio: ['pipe', 'ignore', 'inherit'],
      env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Doppler rejected ${name}.`)),
    );
    child.stdin.end(value);
  });
}
