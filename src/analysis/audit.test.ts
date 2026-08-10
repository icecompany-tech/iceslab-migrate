import { describe, expect, it } from 'vitest';
import { auditInventory, remarkPhrase } from './audit.js';
import type {
  SourceHost,
  SourceInventory,
  SourceProfile,
  SourceUser,
} from '../sources/types.js';

// ───── Fixture builders ─────
//
// Shaped after the live panel this tool was written against: one profile whose
// config carries the whole routing table, hosts that select a route by id, and
// squads that are denied hosts rather than granted them.

function user(over: Partial<SourceUser> = {}): SourceUser {
  return {
    id: over.id ?? `u-${Math.random().toString(36).slice(2, 10)}`,
    username: 'alice',
    subscriptionToken: 'abcdefghijk',
    status: 'ACTIVE',
    expireAt: new Date('2027-01-01T00:00:00Z'),
    trafficLimitBytes: 0,
    trafficLimitStrategy: 'NO_RESET',
    usedTrafficBytes: 0,
    lifetimeUsedTrafficBytes: 0,
    lastTrafficResetAt: null,
    subRevokedAt: null,
    telegramId: null,
    email: null,
    description: null,
    tag: null,
    hwidDeviceLimit: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    credentials: { vless: '11111111-2222-3333-4444-555555555555' },
    squadIds: [],
    ...over,
  };
}

function host(over: Partial<SourceHost> = {}): SourceHost {
  return {
    id: over.id ?? `h-${Math.random().toString(36).slice(2, 10)}`,
    remark: '🇨🇭 Switzerland XHTTP',
    address: 'ch1.example.net',
    port: 443,
    sni: null,
    fingerprint: 'edge',
    routeId: 1,
    enabled: true,
    inboundId: 'in-1',
    sniFromAddress: false,
    securityLayer: 'DEFAULT',
    allowInsecure: false,
    excludedSquadIds: [],
    unmappedSettings: {},
    ...over,
  };
}

function profile(over: Partial<SourceProfile> = {}): SourceProfile {
  return {
    id: 'p-1',
    name: 'Relay',
    inbounds: [
      {
        id: 'in-1',
        tag: 'vless-in',
        protocol: 'vless',
        port: 443,
        network: 'xhttp',
        security: 'reality',
        serverNames: ['a.example', 'b.example'],
        raw: null,
      },
    ],
    routingRules: [
      { routeExpr: 1, outboundTag: 'ch', matches: 'catch-all' },
      { routeExpr: '11-19', outboundTag: 'direct', matches: 'domain: geosite:youtube' },
      { routeExpr: '2-9,12-19,99', outboundTag: 'TORRENT', matches: 'protocol: bittorrent' },
    ],
    outboundTags: ['ch', 'direct', 'TORRENT', 'block'],
    hasDnsSection: true,
    externalAssets: ['geosite_RU.dat'],
    ...over,
  };
}

function inventory(over: Partial<SourceInventory> = {}): SourceInventory {
  return {
    ref: { kind: 'remnawave', url: 'https://panel.example' },
    users: [user()],
    squads: [
      { id: 's-1', name: 'Basic', memberCount: 1 },
      { id: 's-2', name: 'Premium', memberCount: 1 },
    ],
    hosts: [host()],
    profiles: [profile()],
    devices: [],
    nodes: [],
    subscriptionSettings: null,
    unreadFields: {},
    ...over,
  };
}

function codes(result: ReturnType<typeof auditInventory>): string[] {
  return result.findings.map((f) => f.code);
}

function find(result: ReturnType<typeof auditInventory>, code: string) {
  const hit = result.findings.find((f) => f.code === code);
  if (!hit) throw new Error(`expected finding "${code}", got: ${codes(result).join(', ')}`);
  return hit;
}

// ───── Users ─────

describe('user checks', () => {
  it('passes a clean set without inventing blockers', () => {
    const result = auditInventory(inventory());
    expect(result.findings.filter((f) => f.severity === 'blocker')).toEqual([]);
  });

  it('flags usernames our schema rejects', () => {
    const result = auditInventory(
      inventory({ users: [user({ username: 'вася петров' }), user({ username: 'ok-name' })] }),
    );
    expect(find(result, 'username-invalid').count).toBe(1);
  });

  it('flags duplicate usernames, which our API could never edit afterwards', () => {
    const result = auditInventory(
      inventory({
        users: [
          user({ id: 'a', username: 'same', subscriptionToken: 'tokentoken1' }),
          user({ id: 'b', username: 'same', subscriptionToken: 'tokentoken2' }),
        ],
      }),
    );
    expect(find(result, 'username-duplicate').count).toBe(1);
  });

  it('flags duplicate subscription tokens', () => {
    const result = auditInventory(
      inventory({
        users: [
          user({ id: 'a', username: 'one', subscriptionToken: 'shared-token' }),
          user({ id: 'b', username: 'two', subscriptionToken: 'shared-token' }),
        ],
      }),
    );
    expect(find(result, 'sub-token-duplicate').count).toBe(1);
  });

  it('flags a status with no equivalent, and stays quiet about ones that map', () => {
    const mapped = auditInventory(
      inventory({
        users: [user({ status: 'ACTIVE' }), user({ status: 'expired', username: 'bob' })],
      }),
    );
    expect(codes(mapped)).not.toContain('status-unmappable');

    const unmapped = auditInventory(inventory({ users: [user({ status: 'INACTIVE' })] }));
    expect(find(unmapped, 'status-unmappable').count).toBe(1);
  });

  it('maps their rolling reset period instead of calling it unknown', () => {
    const result = auditInventory(
      inventory({ users: [user({ trafficLimitStrategy: 'MONTH_ROLLING' })] }),
    );
    expect(codes(result)).not.toContain('strategy-unmappable');
  });

  it('reports a shared telegram id as an anomaly, not a blocker', () => {
    const result = auditInventory(
      inventory({
        users: [
          user({ id: 'a', username: 'one', subscriptionToken: 'tokentoken1', telegramId: '777' }),
          user({ id: 'b', username: 'two', subscriptionToken: 'tokentoken2', telegramId: '777' }),
        ],
      }),
    );
    const finding = find(result, 'telegram-id-shared');
    expect(finding.severity).toBe('anomaly');
    expect(finding.count).toBe(1);
  });

  it('treats a 2099 expiry as a convention worth deciding about', () => {
    const result = auditInventory(
      inventory({ users: [user({ expireAt: new Date('2099-12-31T00:00:00Z') })] }),
    );
    expect(find(result, 'expiry-means-never').count).toBe(1);
  });

  it('says nothing about trojan secrets when no inbound serves trojan', () => {
    const result = auditInventory(
      inventory({
        users: [user({ credentials: { vless: '11111111-2222-3333-4444-555555555555', trojan: 'x' } })],
      }),
    );
    expect(find(result, 'credential-no-home-trojan').severity).toBe('note');
  });

  it('escalates the same secret to a blocker when an inbound actually serves it', () => {
    const withTrojan = profile({
      inbounds: [
        {
          id: 'in-1',
          tag: 'trojan-in',
          protocol: 'trojan',
          port: 443,
          network: 'tcp',
          security: 'tls',
          serverNames: [],
          raw: null,
        },
      ],
    });
    const result = auditInventory(
      inventory({
        profiles: [withTrojan],
        users: [user({ credentials: { vless: '11111111-2222-3333-4444-555555555555', trojan: 'x' } })],
      }),
    );
    expect(find(result, 'credential-no-home-trojan').severity).toBe('blocker');
  });
});

// ───── Topology ─────

describe('topology', () => {
  it('resolves a host to the outbounds its route id reaches', () => {
    const result = auditInventory(inventory({ hosts: [host({ routeId: 13 })] }));
    // 13 is inside "11-19" and inside "12-19" of the torrent rule, but not the
    // single-id rule for 1. Getting the ranges wrong here is exactly how a
    // subscriber ends up leaving from the wrong country.
    expect(result.topology[0]?.outbounds).toEqual(['direct', 'TORRENT']);
  });

  it('counts a comma-separated address as several hosts on our side', () => {
    const result = auditInventory(
      inventory({ hosts: [host({ address: 'ru21.example, ru22.example ,ru23.example' })] }),
    );
    expect(result.topology[0]?.addresses).toEqual([
      'ru21.example',
      'ru22.example',
      'ru23.example',
    ]);
    expect(result.counts.hostsAfterAddressExpansion).toBe(3);
    expect(find(result, 'host-multi-address').count).toBe(1);
  });

  it('inverts squad exclusions into grants, per squad', () => {
    const result = auditInventory(
      inventory({
        hosts: [
          host({ id: 'h1', excludedSquadIds: ['s-1'] }),
          host({ id: 'h2', excludedSquadIds: [] }),
        ],
      }),
    );
    const basic = result.squadGrants.find((g) => g.squad === 'Basic');
    const premium = result.squadGrants.find((g) => g.squad === 'Premium');
    expect(basic?.hostCount).toBe(1);
    expect(basic?.seesEverything).toBe(false);
    // Premium is denied nothing, so it must keep our "no rows means all" default
    // instead of being pinned to today's host list.
    expect(premium?.hostCount).toBe(2);
    expect(premium?.seesEverything).toBe(true);
  });

  it('spells out how to expand a multi-address host that derives its TLS name', () => {
    const result = auditInventory(
      inventory({
        hosts: [host({ address: 'ru21.example,ru22.example', sniFromAddress: true })],
      }),
    );
    expect(find(result, 'host-sni-from-address').detail).toContain('several addresses');
  });

  it('flags a host whose inbound is in no profile', () => {
    const result = auditInventory(inventory({ hosts: [host({ inboundId: 'nope' })] }));
    expect(find(result, 'host-orphan-inbound').count).toBe(1);
  });

  it('flags a route id no rule covers', () => {
    const result = auditInventory(inventory({ hosts: [host({ routeId: 42 })] }));
    expect(find(result, 'host-route-unrouted').count).toBe(1);
  });

  it('flags the same product label sitting on two different routes', () => {
    // The live case: a host labelled as the ad-free tier parked on the with-ads
    // route. Both readings are plausible, so the audit refuses to pick one.
    const result = auditInventory(
      inventory({
        hosts: [
          host({ id: 'a', remark: '🇨🇭 Switzerland No Ads XHTTP', routeId: 11 }),
          host({ id: 'b', remark: '🇨🇭 Switzerland No Ads [V] H2', routeId: 1 }),
        ],
      }),
    );
    const finding = find(result, 'route-label-contradiction');
    expect(finding.count).toBe(1);
    expect(finding.samples?.[0]).toContain('routes 1, 11');
  });

  it('does not confuse two transports of the same product for a contradiction', () => {
    const result = auditInventory(
      inventory({
        hosts: [
          host({ id: 'a', remark: '🇹🇷 Turkey XHTTP', routeId: 2 }),
          host({ id: 'b', remark: '🇹🇷 Turkey gRPC', routeId: 2 }),
        ],
      }),
    );
    expect(codes(result)).not.toContain('route-label-contradiction');
  });
});

describe('remarkPhrase', () => {
  it('strips transport noise, markers and decoration', () => {
    expect(remarkPhrase('🇨🇭 Switzerland No Ads [V] H2')).toBe('switzerland no ads');
    expect(remarkPhrase('🇹🇷 Turkey XHTTP')).toBe('turkey');
    expect(remarkPhrase('ru-01 gRPC REALITY')).toBe('ru 01');
  });
});

// ───── Profiles ─────

describe('profile checks', () => {
  it('flags a REALITY name list longer than our cap', () => {
    const wide = profile({
      inbounds: [
        {
          id: 'in-1',
          tag: 'vless-in',
          protocol: 'vless',
          port: 443,
          network: 'xhttp',
          security: 'reality',
          serverNames: Array.from({ length: 40 }, (_, i) => `n${i}.example`),
          raw: null,
        },
      ],
    });
    const finding = find(auditInventory(inventory({ profiles: [wide] })), 'reality-server-names-over-limit');
    expect(finding.severity).toBe('blocker');
  });

  it('always says routing is not converted, since that is the whole boundary', () => {
    const result = auditInventory(inventory());
    expect(find(result, 'routing-not-converted').severity).toBe('manual');
    expect(find(result, 'external-assets').samples).toContain('geosite_RU.dat');
  });

  it('flags an inbound a stock engine cannot load', () => {
    const exotic = profile({
      inbounds: [
        {
          id: 'in-1',
          tag: 'hy-in',
          protocol: 'hysteria',
          port: 443,
          network: 'hysteria',
          security: null,
          serverNames: [],
          raw: null,
        },
      ],
    });
    expect(find(auditInventory(inventory({ profiles: [exotic] })), 'inbound-not-stock').count).toBe(1);
  });
});

// ───── Route catalog ─────

describe('route catalog', () => {
  it('groups hosts by route and lists what each is sold as', () => {
    const result = auditInventory(
      inventory({
        hosts: [
          host({ id: 'a', remark: '🇨🇭 Switzerland XHTTP', routeId: 1 }),
          host({ id: 'b', remark: '🇨🇭 Switzerland gRPC', routeId: 1, enabled: false }),
          host({ id: 'c', remark: '🇺🇸 USA No Ads XHTTP', routeId: 13 }),
        ],
      }),
    );
    expect(result.routeCatalog).toEqual([
      { routeId: 1, hostCount: 2, enabledHostCount: 1, phrases: ['switzerland'], outbounds: ['ch'] },
      {
        routeId: 13,
        hostCount: 1,
        enabledHostCount: 1,
        phrases: ['usa no ads'],
        outbounds: ['direct', 'TORRENT'],
      },
    ]);
  });
});
