import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudflareProvisioner } from '../src/infrastructure/cloudflare-provisioner.js';

const accountId = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const dnsId = 'c'.repeat(32);
const tunnelId = '11111111-1111-4111-8111-111111111111';
const input = {
  accountId,
  apiToken: 'test-token-with-sufficient-length',
  zoneName: 'expeditions.gg',
  publicHostname: 'macro.expeditions.gg',
  tunnelName: 'lilacmacro-services-production',
};

test('Cloudflare provisioning updates one exact tunnel, ingress, and proxied DNS record', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const responses = [
    envelope([{ id: zoneId, name: 'expeditions.gg' }]),
    envelope([{ id: tunnelId, name: input.tunnelName }]),
    envelope({}),
    envelope([
      {
        id: dnsId,
        name: input.publicHostname,
        type: 'CNAME',
        content: 'old.cfargotunnel.com',
        proxied: true,
      },
    ]),
    envelope({
      id: dnsId,
      name: input.publicHostname,
      type: 'CNAME',
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
    }),
    envelope('tunnel-token-with-sufficient-length'),
  ];
  const provisioner = new CloudflareProvisioner(async (url, init) => {
    requests.push({ url: String(url), init });
    return responses.shift()!;
  });

  const result = await provisioner.provision(input);

  assert.equal(result.tunnelId, tunnelId);
  assert.equal(result.dnsRecordId, dnsId);
  assert.equal(requests[2]?.init?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), {
    config: {
      ingress: [
        { hostname: input.publicHostname, service: 'http://api:3100' },
        { service: 'http_status:404' },
      ],
    },
  });
  assert.equal(requests[4]?.init?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(requests[4]?.init?.body)), {
    type: 'CNAME',
    name: input.publicHostname,
    content: `${tunnelId}.cfargotunnel.com`,
    ttl: 1,
    proxied: true,
    comment: 'LilacMacro Services managed tunnel',
  });
  assert.ok(requests.every((request) => !request.url.includes(input.apiToken)));
});

test('Cloudflare provisioning creates missing tunnel and DNS resources', async () => {
  const methods: string[] = [];
  const responses = [
    envelope([{ id: zoneId, name: input.zoneName }]),
    envelope([]),
    envelope({ id: tunnelId, name: input.tunnelName }),
    envelope({}),
    envelope([]),
    envelope({
      id: dnsId,
      name: input.publicHostname,
      type: 'CNAME',
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
    }),
    envelope('new-tunnel-token-with-sufficient-length'),
  ];
  const provisioner = new CloudflareProvisioner(async (_url, init) => {
    methods.push(init?.method ?? 'GET');
    return responses.shift()!;
  });

  await provisioner.provision(input);

  assert.deepEqual(methods, ['GET', 'GET', 'POST', 'PUT', 'GET', 'POST', 'GET']);
});

test('Cloudflare provisioning rejects cross-zone names and redacts provider errors', async () => {
  const provisioner = new CloudflareProvisioner(
    async () => new Response('{"error":"secret response"}', { status: 403 }),
  );
  await assert.rejects(
    provisioner.provision({ ...input, publicHostname: 'macro.example.net' }),
    /outside the configured Cloudflare zone/,
  );
  await assert.rejects(provisioner.provision(input), (error: unknown) => {
    assert.match(String(error), /HTTP 403/);
    assert.doesNotMatch(String(error), /secret response/);
    return true;
  });
});

function envelope(result: unknown): Response {
  return Response.json({ success: true, result });
}
