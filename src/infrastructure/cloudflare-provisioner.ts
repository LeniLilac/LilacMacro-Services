import { z } from 'zod';

const identifier = z.string().regex(/^[a-f0-9]{32}$/i);
const hostname = z
  .string()
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const inputSchema = z
  .object({
    accountId: identifier,
    accountApiToken: z.string().min(20).max(512),
    zoneApiToken: z.string().min(20).max(512),
    zoneName: hostname,
    publicHostname: hostname,
    tunnelName: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  })
  .strict();
const zoneSchema = z.object({ id: identifier, name: hostname });
const tunnelSchema = z.object({ id: z.uuid(), name: z.string() });
const dnsRecordSchema = z.object({
  id: identifier,
  name: hostname,
  type: z.string(),
  content: z.string(),
  proxied: z.boolean().optional(),
});
const rulesetSummarySchema = z.object({
  id: identifier,
  kind: z.string(),
  phase: z.string(),
});
const ruleSummarySchema = z
  .object({
    id: identifier,
    ref: z.string().optional(),
  })
  .passthrough();
const rulesetSchema = rulesetSummarySchema.extend({
  rules: z.array(ruleSummarySchema).default([]),
});
const envelopeSchema = z.object({ success: z.literal(true), result: z.unknown() });
const redirectPhase = 'http_request_dynamic_redirect';
const redirectRuleRef = 'lilacmacro_canonical_origin';

export interface CloudflareProvisioningInput {
  accountId: string;
  accountApiToken: string;
  zoneApiToken: string;
  zoneName: string;
  publicHostname: string;
  tunnelName: string;
}

export interface CloudflareProvisioningResult {
  tunnelId: string;
  tunnelToken: string;
  zoneId: string;
  dnsRecordId: string;
  redirectDnsRecordIds: string[];
  redirectRulesetId: string;
}

export class CloudflareProvisioner {
  public constructor(private readonly fetcher: typeof fetch = fetch) {}

  public async provision(
    rawInput: CloudflareProvisioningInput,
  ): Promise<CloudflareProvisioningResult> {
    const input = inputSchema.parse(rawInput);
    assertHostnameInZone(input.publicHostname, input.zoneName);
    const zone = await this.requireZone(input);
    const tunnel = await this.requireTunnel(input);
    await this.configureTunnel(input, tunnel.id);
    const record = await this.upsertDnsRecord(input, zone.id, tunnel.id);
    const redirectDnsRecords = await this.upsertRedirectDnsRecords(input, zone.id, tunnel.id);
    const redirectRuleset = await this.upsertCanonicalRedirect(input, zone.id);
    const tunnelToken = await this.request(
      input.accountApiToken,
      `/accounts/${input.accountId}/cfd_tunnel/${tunnel.id}/token`,
      'GET',
      z.string().min(20).max(4_096),
    );
    return {
      tunnelId: tunnel.id,
      tunnelToken,
      zoneId: zone.id,
      dnsRecordId: record.id,
      redirectDnsRecordIds: redirectDnsRecords.map(({ id }) => id),
      redirectRulesetId: redirectRuleset.id,
    };
  }

  private async requireZone(
    input: z.infer<typeof inputSchema>,
  ): Promise<z.infer<typeof zoneSchema>> {
    const zones = await this.request(
      input.zoneApiToken,
      `/zones?name=${encodeURIComponent(input.zoneName)}&status=active`,
      'GET',
      z.array(zoneSchema).max(2),
    );
    if (zones.length !== 1 || zones[0]?.name !== input.zoneName) {
      throw new Error('Cloudflare zone lookup did not return one exact active zone.');
    }
    return zones[0];
  }

  private async requireTunnel(
    input: z.infer<typeof inputSchema>,
  ): Promise<z.infer<typeof tunnelSchema>> {
    const tunnels = await this.request(
      input.accountApiToken,
      `/accounts/${input.accountId}/cfd_tunnel?name=${encodeURIComponent(input.tunnelName)}&is_deleted=false`,
      'GET',
      z.array(tunnelSchema).max(2),
    );
    if (tunnels.length > 1) throw new Error('Cloudflare tunnel name was ambiguous.');
    if (tunnels[0]) {
      if (tunnels[0].name !== input.tunnelName)
        throw new Error('Cloudflare tunnel name mismatched.');
      return tunnels[0];
    }
    return this.request(
      input.accountApiToken,
      `/accounts/${input.accountId}/cfd_tunnel`,
      'POST',
      tunnelSchema,
      {
        name: input.tunnelName,
        config_src: 'cloudflare',
      },
    );
  }

  private async configureTunnel(
    input: z.infer<typeof inputSchema>,
    tunnelId: string,
  ): Promise<void> {
    await this.request(
      input.accountApiToken,
      `/accounts/${input.accountId}/cfd_tunnel/${tunnelId}/configurations`,
      'PUT',
      z.unknown(),
      {
        config: {
          ingress: [
            { hostname: input.publicHostname, service: 'http://api:3100' },
            { service: 'http_status:404' },
          ],
        },
      },
    );
  }

  private async upsertDnsRecord(
    input: z.infer<typeof inputSchema>,
    zoneId: string,
    tunnelId: string,
  ): Promise<z.infer<typeof dnsRecordSchema>> {
    const records = await this.request(
      input.zoneApiToken,
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(input.publicHostname)}`,
      'GET',
      z.array(dnsRecordSchema).max(2),
    );
    if (records.length > 1) throw new Error('Cloudflare DNS hostname was ambiguous.');
    const existing = records[0];
    if (existing && existing.type !== 'CNAME') {
      throw new Error('Cloudflare DNS hostname already used a non-CNAME record.');
    }
    const body = {
      type: 'CNAME',
      name: input.publicHostname,
      content: `${tunnelId}.cfargotunnel.com`,
      ttl: 1,
      proxied: true,
      comment: 'LilacMacro Services managed tunnel',
    };
    return this.request(
      input.zoneApiToken,
      existing ? `/zones/${zoneId}/dns_records/${existing.id}` : `/zones/${zoneId}/dns_records`,
      existing ? 'PUT' : 'POST',
      dnsRecordSchema,
      body,
    );
  }

  private async upsertRedirectDnsRecords(
    input: z.infer<typeof inputSchema>,
    zoneId: string,
    tunnelId: string,
  ): Promise<Array<z.infer<typeof dnsRecordSchema>>> {
    const redirectHostnames = [input.zoneName, `www.${input.zoneName}`];
    const records = [];
    for (const redirectHostname of redirectHostnames) {
      records.push(
        await this.replaceDnsHostnameWithTunnelAlias(
          input.zoneApiToken,
          zoneId,
          redirectHostname,
          tunnelId,
        ),
      );
    }
    return records;
  }

  private async replaceDnsHostnameWithTunnelAlias(
    apiToken: string,
    zoneId: string,
    recordHostname: string,
    tunnelId: string,
  ): Promise<z.infer<typeof dnsRecordSchema>> {
    const records = await this.request(
      apiToken,
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(recordHostname)}`,
      'GET',
      z.array(dnsRecordSchema).max(20),
    );
    const aliases = records.filter(({ type }) => type === 'CNAME');
    if (aliases.length > 1 || (aliases.length === 1 && records.length > 1)) {
      throw new Error('Cloudflare redirect DNS hostname was ambiguous.');
    }
    for (const record of records.filter(({ type }) => type !== 'CNAME')) {
      await this.request(
        apiToken,
        `/zones/${zoneId}/dns_records/${record.id}`,
        'DELETE',
        z.unknown(),
      );
    }
    const existing = aliases[0];
    const body = {
      type: 'CNAME',
      name: recordHostname,
      content: `${tunnelId}.cfargotunnel.com`,
      ttl: 1,
      proxied: true,
      comment: 'LilacMacro canonical-origin redirect',
    };
    return this.request(
      apiToken,
      existing ? `/zones/${zoneId}/dns_records/${existing.id}` : `/zones/${zoneId}/dns_records`,
      existing ? 'PUT' : 'POST',
      dnsRecordSchema,
      body,
    );
  }

  private async upsertCanonicalRedirect(
    input: z.infer<typeof inputSchema>,
    zoneId: string,
  ): Promise<z.infer<typeof rulesetSchema>> {
    const summaries = await this.request(
      input.zoneApiToken,
      `/zones/${zoneId}/rulesets`,
      'GET',
      z.array(rulesetSummarySchema).max(100),
    );
    const phaseRulesets = summaries.filter(
      ({ kind, phase }) => kind === 'zone' && phase === redirectPhase,
    );
    if (phaseRulesets.length > 1) throw new Error('Cloudflare redirect ruleset was ambiguous.');
    const rule = canonicalRedirectRule(input.zoneName, input.publicHostname);
    const summary = phaseRulesets[0];
    if (!summary) {
      return this.request(input.zoneApiToken, `/zones/${zoneId}/rulesets`, 'POST', rulesetSchema, {
        name: 'LilacMacro canonical redirects',
        description: 'Redirect public aliases to the canonical LilacMacro origin.',
        kind: 'zone',
        phase: redirectPhase,
        rules: [rule],
      });
    }
    const ruleset = await this.request(
      input.zoneApiToken,
      `/zones/${zoneId}/rulesets/${summary.id}`,
      'GET',
      rulesetSchema,
    );
    const ownedRules = ruleset.rules.filter(({ ref }) => ref === redirectRuleRef);
    if (ownedRules.length > 1) throw new Error('Cloudflare canonical redirect rule was ambiguous.');
    const ownedRule = ownedRules[0];
    return this.request(
      input.zoneApiToken,
      ownedRule
        ? `/zones/${zoneId}/rulesets/${ruleset.id}/rules/${ownedRule.id}`
        : `/zones/${zoneId}/rulesets/${ruleset.id}/rules`,
      ownedRule ? 'PATCH' : 'POST',
      rulesetSchema,
      rule,
    );
  }

  private async request<T>(
    apiToken: string,
    path: string,
    method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT',
    resultSchema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiToken}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Cloudflare API request failed with HTTP ${response.status}.`);
    }
    const parsed = envelopeSchema.parse(await readBoundedJson(response));
    return resultSchema.parse(parsed.result);
  }
}

function canonicalRedirectRule(zoneName: string, publicHostname: string): Record<string, unknown> {
  return {
    ref: redirectRuleRef,
    expression: `(http.host eq "${zoneName}" or http.host eq "www.${zoneName}")`,
    description: 'Redirect apex and www to the canonical LilacMacro origin.',
    action: 'redirect',
    action_parameters: {
      from_value: {
        target_url: {
          expression: `concat("https://${publicHostname}", http.request.uri.path)`,
        },
        status_code: 308,
        preserve_query_string: true,
      },
    },
    enabled: true,
  };
}

function assertHostnameInZone(publicHostname: string, zoneName: string): void {
  if (publicHostname !== zoneName && !publicHostname.endsWith(`.${zoneName}`)) {
    throw new Error('Public hostname was outside the configured Cloudflare zone.');
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const maximumBytes = 256 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Cloudflare API response body was unavailable.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Cloudflare API response exceeded its size limit.');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
