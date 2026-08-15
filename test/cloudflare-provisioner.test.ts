import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudflareProvisioner } from '../src/infrastructure/cloudflare-provisioner.js';

const accountId = 'a'.repeat(32);
const zoneId = 'b'.repeat(32);
const dnsId = 'c'.repeat(32);
const apexDnsId = 'd'.repeat(32);
const alternateApexDnsId = 'e'.repeat(32);
const wwwDnsId = 'f'.repeat(32);
const rulesetId = '1'.repeat(32);
const ruleId = '2'.repeat(32);
const tunnelId = '11111111-1111-4111-8111-111111111111';
const input = {
  accountId,
  accountApiToken: 'account-token-with-sufficient-length',
  zoneApiToken: 'zone-token-with-sufficient-length',
  zoneName: 'expeditions.gg',
  publicHostname: 'macro.expeditions.gg',
  tunnelName: 'lilacmacro-services-production',
};

test('Cloudflare provisioning replaces parking DNS and creates canonical redirects', async () => {
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
    envelope([
      {
        id: apexDnsId,
        name: input.zoneName,
        type: 'A',
        content: '192.0.2.1',
        proxied: true,
      },
      {
        id: alternateApexDnsId,
        name: input.zoneName,
        type: 'A',
        content: '192.0.2.2',
        proxied: true,
      },
    ]),
    envelope({}),
    envelope({}),
    envelope({
      id: apexDnsId,
      name: input.zoneName,
      type: 'CNAME',
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
    }),
    envelope([]),
    envelope({
      id: wwwDnsId,
      name: `www.${input.zoneName}`,
      type: 'CNAME',
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
    }),
    envelope([]),
    envelope({
      id: rulesetId,
      kind: 'zone',
      phase: 'http_request_dynamic_redirect',
      rules: [{ id: ruleId, ref: 'lilacmacro_canonical_origin' }],
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
  assert.deepEqual(result.redirectDnsRecordIds, [apexDnsId, wwwDnsId]);
  assert.equal(result.redirectRulesetId, rulesetId);
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
  assert.equal(requests[6]?.init?.method, 'DELETE');
  assert.equal(requests[7]?.init?.method, 'DELETE');
  assert.equal(requests[8]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[8]?.init?.body)), {
    type: 'CNAME',
    name: input.zoneName,
    content: `${tunnelId}.cfargotunnel.com`,
    ttl: 1,
    proxied: true,
    comment: 'LilacMacro canonical-origin redirect',
  });
  assert.equal(requests[10]?.init?.method, 'POST');
  assert.equal(requests[12]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[12]?.init?.body)), {
    name: 'LilacMacro canonical redirects',
    description: 'Redirect public aliases to the canonical LilacMacro origin.',
    kind: 'zone',
    phase: 'http_request_dynamic_redirect',
    rules: [
      {
        ref: 'lilacmacro_canonical_origin',
        expression: '(http.host eq "expeditions.gg" or http.host eq "www.expeditions.gg")',
        description: 'Redirect apex and www to the canonical LilacMacro origin.',
        action: 'redirect',
        action_parameters: {
          from_value: {
            target_url: {
              expression: 'concat("https://macro.expeditions.gg", http.request.uri.path)',
            },
            status_code: 308,
            preserve_query_string: true,
          },
        },
        enabled: true,
      },
    ],
  });
  for (const request of requests) {
    const authorization = new Headers(request.init?.headers).get('authorization');
    if (request.url.includes('/zones')) {
      assert.equal(authorization, `Bearer ${input.zoneApiToken}`);
    } else {
      assert.equal(authorization, `Bearer ${input.accountApiToken}`);
    }
  }
  assert.ok(requests.every((request) => !request.url.includes(input.accountApiToken)));
  assert.ok(requests.every((request) => !request.url.includes(input.zoneApiToken)));
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
    envelope([]),
    envelope({
      id: apexDnsId,
      name: input.zoneName,
      type: 'CNAME',
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
    }),
    envelope([]),
    envelope({
      id: wwwDnsId,
      name: `www.${input.zoneName}`,
      type: 'CNAME',
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
    }),
    envelope([]),
    envelope({
      id: rulesetId,
      kind: 'zone',
      phase: 'http_request_dynamic_redirect',
      rules: [{ id: ruleId, ref: 'lilacmacro_canonical_origin' }],
    }),
    envelope('new-tunnel-token-with-sufficient-length'),
  ];
  const provisioner = new CloudflareProvisioner(async (_url, init) => {
    methods.push(init?.method ?? 'GET');
    return responses.shift()!;
  });

  await provisioner.provision(input);

  assert.deepEqual(methods, [
    'GET',
    'GET',
    'POST',
    'PUT',
    'GET',
    'POST',
    'GET',
    'POST',
    'GET',
    'POST',
    'GET',
    'POST',
    'GET',
  ]);
});

test('Cloudflare provisioning updates only its owned redirect rule', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const responses = [
    envelope([{ id: zoneId, name: input.zoneName }]),
    envelope([{ id: tunnelId, name: input.tunnelName }]),
    envelope({}),
    envelope([
      {
        id: dnsId,
        name: input.publicHostname,
        type: 'CNAME',
        content: `${tunnelId}.cfargotunnel.com`,
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
    envelope([
      {
        id: apexDnsId,
        name: input.zoneName,
        type: 'CNAME',
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
      },
    ]),
    envelope({
      id: apexDnsId,
      name: input.zoneName,
      type: 'CNAME',
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
    }),
    envelope([
      {
        id: wwwDnsId,
        name: `www.${input.zoneName}`,
        type: 'CNAME',
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
      },
    ]),
    envelope({
      id: wwwDnsId,
      name: `www.${input.zoneName}`,
      type: 'CNAME',
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
    }),
    envelope([{ id: rulesetId, kind: 'zone', phase: 'http_request_dynamic_redirect' }]),
    envelope({
      id: rulesetId,
      kind: 'zone',
      phase: 'http_request_dynamic_redirect',
      rules: [
        { id: '3'.repeat(32), ref: 'unrelated_redirect' },
        { id: ruleId, ref: 'lilacmacro_canonical_origin' },
      ],
    }),
    envelope({
      id: rulesetId,
      kind: 'zone',
      phase: 'http_request_dynamic_redirect',
      rules: [
        { id: '3'.repeat(32), ref: 'unrelated_redirect' },
        { id: ruleId, ref: 'lilacmacro_canonical_origin' },
      ],
    }),
    envelope('tunnel-token-with-sufficient-length'),
  ];
  const provisioner = new CloudflareProvisioner(async (url, init) => {
    requests.push({ url: String(url), init });
    return responses.shift()!;
  });

  await provisioner.provision(input);

  assert.equal(requests[11]?.init?.method, 'PATCH');
  assert.match(requests[11]?.url ?? '', new RegExp(`/rulesets/${rulesetId}/rules/${ruleId}$`));
  assert.doesNotMatch(String(requests[11]?.init?.body), /unrelated_redirect/);
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
