/**
 * Adapter for a Remnawave-style source panel.
 *
 * Named outright, and deliberately: everywhere else in Iceslab we describe rival
 * panels generically, but a migration tool that will not say what it migrates
 * FROM is useless to the person looking for it. The exception is scoped to this
 * repository.
 *
 * Schemas here are permissive on purpose. The source is someone else's product
 * on their release schedule: a field we have never seen must not abort an audit
 * of 30 000 subscribers. Instead every unknown key is collected and printed, so
 * a version drift shows up as a line in the report rather than as data we
 * quietly failed to carry.
 */

import { z } from 'zod';
import {
  asList,
  fetchAllPaged,
  ReadOnlyClient,
  SourceHttpError,
  unwrapEnvelope,
} from './client.js';
import type {
  SourceAdapter,
  SourceDevice,
  SourceHost,
  SourceInbound,
  SourceInventory,
  SourceNode,
  SourceProfile,
  SourceRoutingRule,
  SourceSquad,
  SourceSubscriptionSettings,
  SourceUser,
} from '../types.js';

// ───── Response shapes ─────
//
// Only the fields the migration actually consumes are declared. `.loose()`
// keeps the rest of the payload instead of stripping it, which is what makes
// the unknown-key report possible.

const UserSchema = z
  .object({
    uuid: z.string(),
    username: z.string(),
    shortUuid: z.string(),
    status: z.string(),
    trafficLimitBytes: z.number().nullish(),
    trafficLimitStrategy: z.string().nullish(),
    expireAt: z.string().nullish(),
    telegramId: z.union([z.number(), z.string()]).nullish(),
    email: z.string().nullish(),
    description: z.string().nullish(),
    tag: z.string().nullish(),
    hwidDeviceLimit: z.number().nullish(),
    trojanPassword: z.string().nullish(),
    vlessUuid: z.string().nullish(),
    ssPassword: z.string().nullish(),
    subRevokedAt: z.string().nullish(),
    lastTrafficResetAt: z.string().nullish(),
    createdAt: z.string().nullish(),
    activeInternalSquads: z.array(z.object({ uuid: z.string() }).loose()).nullish(),
    userTraffic: z
      .object({
        usedTrafficBytes: z.number().nullish(),
        lifetimeUsedTrafficBytes: z.number().nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

const SquadSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    info: z.object({ membersCount: z.number().nullish() }).loose().nullish(),
    membersCount: z.number().nullish(),
  })
  .loose();

const HostSchema = z
  .object({
    uuid: z.string(),
    remark: z.string(),
    address: z.string(),
    port: z.number().nullish(),
    sni: z.string().nullish(),
    fingerprint: z.string().nullish(),
    vlessRouteId: z.number().nullish(),
    isDisabled: z.boolean().nullish(),
    overrideSniFromAddress: z.boolean().nullish(),
    keepSniBlank: z.boolean().nullish(),
    securityLayer: z.string().nullish(),
    allowInsecure: z.boolean().nullish(),
    // The link to the inbound moved into a nested object at some point. Both
    // spellings are accepted because the version an operator is running is not
    // something we get to choose, and reading neither would report every host
    // on the panel as an orphan - which is exactly how this was caught.
    configProfileInboundUuid: z.string().nullish(),
    inbound: z
      .object({
        configProfileUuid: z.string().nullish(),
        configProfileInboundUuid: z.string().nullish(),
      })
      .loose()
      .nullish(),
    excludedInternalSquads: z
      .array(z.union([z.string(), z.object({ squadUuid: z.string() }).loose()]))
      .nullish(),
  })
  .loose();

const InboundSchema = z
  .object({
    uuid: z.string(),
    tag: z.string(),
    type: z.string().nullish(),
    protocol: z.string().nullish(),
    network: z.string().nullish(),
    security: z.string().nullish(),
    port: z.number().nullish(),
    rawInbound: z.unknown().nullish(),
  })
  .loose();

const ProfileSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    config: z.unknown().nullish(),
    inbounds: z.array(InboundSchema).nullish(),
  })
  .loose();

const DeviceSchema = z
  .object({
    hwid: z.string(),
    userUuid: z.string().nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
  })
  .loose();

const NodeSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    address: z.string().nullish(),
  })
  .loose();

// Keys we knowingly read. Anything else on the wire lands in `unreadFields`.
const KNOWN_KEYS: Record<string, string[]> = {
  users: Object.keys(UserSchema.shape),
  squads: Object.keys(SquadSchema.shape),
  hosts: Object.keys(HostSchema.shape),
  profiles: Object.keys(ProfileSchema.shape),
  inbounds: Object.keys(InboundSchema.shape),
  devices: Object.keys(DeviceSchema.shape),
  nodes: Object.keys(NodeSchema.shape),
};

// Per-device fields we know exist and know we have no column for. Listed so the
// audit can report the loss precisely instead of as "some metadata".
const DEVICE_EXTRA_KEYS = ['platform', 'deviceModel', 'osVersion', 'userAgent'];

export interface RemnawaveAdapterOptions {
  baseUrl: string;
  token: string;
  pageSize?: number;
  throttleMs?: number;
  timeoutMs?: number;
  /** Skip the user sweep. Only useful when poking at topology on a huge panel;
   *  a real audit always reads users. */
  skipUsers?: boolean;
}

export class RemnawaveAdapter implements SourceAdapter {
  readonly kind = 'remnawave';
  private readonly client: ReadOnlyClient;
  private readonly opts: RemnawaveAdapterOptions;
  private readonly unread: Record<string, Set<string>> = {};

  constructor(opts: RemnawaveAdapterOptions) {
    this.opts = opts;
    this.client = new ReadOnlyClient({
      baseUrl: opts.baseUrl,
      token: opts.token,
      timeoutMs: opts.timeoutMs ?? 30_000,
      throttleMs: opts.throttleMs ?? 0,
    });
  }

  async collect(progress: (msg: string) => void): Promise<SourceInventory> {
    const brand = await this.readBrand(progress);

    const squads = await this.readSquads(progress);
    const hosts = await this.readHosts(progress);
    const profiles = await this.readProfiles(progress);
    const nodes = await this.readNodes(progress);
    const devices = await this.readDevices(progress);
    const settings = await this.readSubscriptionSettings(progress);
    const users = this.opts.skipUsers ? [] : await this.readUsers(progress);

    return {
      ref: { kind: this.kind, url: this.opts.baseUrl, brand },
      users,
      squads,
      hosts,
      profiles,
      devices,
      nodes,
      subscriptionSettings: settings,
      unreadFields: Object.fromEntries(
        Object.entries(this.unread).map(([k, v]) => [k, [...v].sort()]),
      ),
    };
  }

  // ───── Individual reads ─────

  private async readBrand(progress: (m: string) => void): Promise<string | undefined> {
    try {
      const body = unwrapEnvelope(await this.client.get('/api/auth/status'));
      if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        for (const key of ['branding', 'brand', 'title', 'tittle', 'name']) {
          const value = record[key];
          if (typeof value === 'string' && value.trim() !== '') return value;
          if (value && typeof value === 'object') {
            const nested = (value as Record<string, unknown>).name ?? (value as Record<string, unknown>).title;
            if (typeof nested === 'string' && nested.trim() !== '') return nested;
          }
        }
      }
    } catch (err) {
      // Branding is decoration. Losing it must not cost us the audit.
      progress(`  (brand unavailable: ${short(err)})`);
    }
    return undefined;
  }

  private async readSquads(progress: (m: string) => void): Promise<SourceSquad[]> {
    progress('reading squads...');
    const raw = asList(await this.client.get('/api/internal-squads'), ['internalSquads', 'squads']);
    this.noteUnknownKeys('squads', raw.items);
    const squads = raw.items.map((item) => SquadSchema.parse(item));
    progress(`  squads: ${squads.length}`);
    return squads.map((s) => ({
      id: s.uuid,
      name: s.name,
      memberCount: s.info?.membersCount ?? s.membersCount ?? null,
    }));
  }

  private async readHosts(progress: (m: string) => void): Promise<SourceHost[]> {
    progress('reading hosts...');
    const raw = asList(await this.client.get('/api/hosts'), ['hosts']);
    this.noteUnknownKeys('hosts', raw.items);
    const hosts = raw.items.map((item) => HostSchema.parse(item));
    progress(`  hosts: ${hosts.length}`);

    return hosts.map((h) => {
      const record = h as unknown as Record<string, unknown>;
      return {
        id: h.uuid,
        remark: h.remark,
        address: h.address,
        port: h.port ?? null,
        sni: h.sni ?? null,
        fingerprint: h.fingerprint ?? null,
        routeId: h.vlessRouteId ?? null,
        enabled: !(h.isDisabled ?? false),
        inboundId: h.inbound?.configProfileInboundUuid ?? h.configProfileInboundUuid ?? null,
        sniFromAddress: h.overrideSniFromAddress ?? false,
        securityLayer: h.securityLayer ?? null,
        allowInsecure: h.allowInsecure ?? false,
        excludedSquadIds: (h.excludedInternalSquads ?? []).map((entry) =>
          typeof entry === 'string' ? entry : entry.squadUuid,
        ),
        unmappedSettings: collectSetExtras(record, HOST_SETTINGS_WE_DO_NOT_MODEL),
      };
    });
  }

  private async readProfiles(progress: (m: string) => void): Promise<SourceProfile[]> {
    progress('reading config profiles...');
    const raw = asList(await this.client.get('/api/config-profiles'), ['configProfiles', 'profiles']);
    this.noteUnknownKeys('profiles', raw.items);
    const profiles = raw.items.map((item) => ProfileSchema.parse(item));
    progress(`  profiles: ${profiles.length}`);

    return profiles.map((p) => {
      const inbounds = (p.inbounds ?? []).map((i) => toInbound(i));
      this.noteUnknownKeys('inbounds', p.inbounds ?? []);
      const config = (p.config ?? {}) as Record<string, unknown>;
      return {
        id: p.uuid,
        name: p.name,
        inbounds,
        routingRules: readRoutingRules(config),
        outboundTags: readOutboundTags(config),
        hasDnsSection: Boolean(config.dns),
        externalAssets: readExternalAssets(config),
      };
    });
  }

  private async readNodes(progress: (m: string) => void): Promise<SourceNode[]> {
    progress('reading nodes...');
    try {
      const raw = asList(await this.client.get('/api/nodes'), ['nodes']);
      this.noteUnknownKeys('nodes', raw.items);
      const nodes = raw.items.map((item) => NodeSchema.parse(item));
      progress(`  nodes: ${nodes.length}`);
      return nodes.map((n) => ({
        id: n.uuid,
        name: n.name,
        address: n.address ?? null,
        raw: n,
      }));
    } catch (err) {
      progress(`  nodes: unavailable (${short(err)})`);
      return [];
    }
  }

  private async readDevices(progress: (m: string) => void): Promise<SourceDevice[]> {
    progress('reading devices...');
    // Device inventories run to tens of thousands; page it like users. If the
    // endpoint ignores paging and hands everything back at once, the first
    // short page ends the loop anyway.
    try {
      const page = await fetchAllPaged(this.client, '/api/hwid/devices', {
        pageSize: this.opts.pageSize ?? 500,
        preferredKeys: ['devices'],
        onPage: (loaded, total) =>
          progress(`  devices: ${loaded}${total !== null ? ` / ${total}` : ''}`),
      });
      this.noteUnknownKeys('devices', page.items);
      const devices = page.items.map((item) => DeviceSchema.parse(item));
      return devices.map((d) => {
        const record = d as unknown as Record<string, unknown>;
        return {
          userId: d.userUuid ?? '',
          hwid: d.hwid,
          createdAt: toDate(d.createdAt),
          updatedAt: toDate(d.updatedAt),
          extra: collectSetExtras(record, DEVICE_EXTRA_KEYS),
        };
      });
    } catch (err) {
      progress(`  devices: unavailable (${short(err)})`);
      return [];
    }
  }

  private async readSubscriptionSettings(
    progress: (m: string) => void,
  ): Promise<SourceSubscriptionSettings | null> {
    progress('reading subscription settings...');
    try {
      const body = unwrapEnvelope(await this.client.get('/api/subscription-settings'));
      if (!body || typeof body !== 'object') return null;
      const record = body as Record<string, unknown>;

      const rules: { name: string; pattern: string }[] = [];
      const responseRules = record.responseRules;
      if (Array.isArray(responseRules)) {
        for (const rule of responseRules) {
          if (rule && typeof rule === 'object') {
            const r = rule as Record<string, unknown>;
            rules.push({
              name: String(r.name ?? r.type ?? r.template ?? '(unnamed)'),
              pattern: String(r.pattern ?? r.regex ?? r.match ?? ''),
            });
          }
        }
      }

      return {
        profileTitle: asString(record.profileTitle),
        supportLink: asString(record.supportLink),
        updateIntervalHours:
          typeof record.profileUpdateInterval === 'number' ? record.profileUpdateInterval : null,
        responseRules: rules,
        unsupported: collectSetExtras(record, SUBSCRIPTION_SETTINGS_WE_DO_NOT_MODEL),
      };
    } catch (err) {
      progress(`  subscription settings: unavailable (${short(err)})`);
      return null;
    }
  }

  private async readUsers(progress: (m: string) => void): Promise<SourceUser[]> {
    progress('reading users (this is the long one)...');
    const page = await fetchAllPaged(this.client, '/api/users', {
      pageSize: this.opts.pageSize ?? 500,
      preferredKeys: ['users'],
      onPage: (loaded, total) => progress(`  users: ${loaded}${total !== null ? ` / ${total}` : ''}`),
    });
    if (page.truncated) {
      throw new Error(
        'User sweep hit its safety cap without reaching the reported total. ' +
          'The endpoint is probably ignoring the `start` parameter, which would ' +
          'make every count in this report wrong.',
      );
    }
    this.noteUnknownKeys('users', page.items);

    return page.items.map((item) => {
      const u = UserSchema.parse(item);
      const credentials: Record<string, string> = {};
      if (u.vlessUuid) credentials.vless = u.vlessUuid;
      if (u.trojanPassword) credentials.trojan = u.trojanPassword;
      if (u.ssPassword) credentials.shadowsocks = u.ssPassword;

      return {
        id: u.uuid,
        username: u.username,
        subscriptionToken: u.shortUuid,
        status: u.status,
        expireAt: toDate(u.expireAt),
        trafficLimitBytes: u.trafficLimitBytes ?? 0,
        trafficLimitStrategy: u.trafficLimitStrategy ?? '',
        usedTrafficBytes: u.userTraffic?.usedTrafficBytes ?? 0,
        lifetimeUsedTrafficBytes: u.userTraffic?.lifetimeUsedTrafficBytes ?? 0,
        lastTrafficResetAt: toDate(u.lastTrafficResetAt),
        subRevokedAt: toDate(u.subRevokedAt),
        telegramId: u.telegramId === null || u.telegramId === undefined ? null : String(u.telegramId),
        email: u.email ?? null,
        description: u.description ?? null,
        tag: u.tag ?? null,
        hwidDeviceLimit: u.hwidDeviceLimit ?? null,
        createdAt: toDate(u.createdAt),
        credentials,
        squadIds: (u.activeInternalSquads ?? []).map((s) => s.uuid),
      };
    });
  }

  private noteUnknownKeys(entity: string, items: unknown[]): void {
    const known = new Set(KNOWN_KEYS[entity] ?? []);
    const bucket = (this.unread[entity] ??= new Set<string>());
    // A handful of rows is enough to learn the shape; scanning 30 000 to find
    // the same keys is pure waste.
    for (const item of items.slice(0, 50)) {
      if (!item || typeof item !== 'object') continue;
      for (const key of Object.keys(item)) {
        if (!known.has(key)) bucket.add(key);
      }
    }
  }
}

// ───── Field groups we knowingly do not model ─────

const HOST_SETTINGS_WE_DO_NOT_MODEL = [
  // Both spellings seen in the wild: their entity says `xhttpExtraParams`,
  // a deployed instance answers with `xHttpExtraParams`.
  'xhttpExtraParams',
  'xHttpExtraParams',
  'muxParams',
  'sockoptParams',
  'finalMask',
  'shuffleHost',
  'mihomoX25519',
  'mihomoIpVersion',
  'xrayJsonTemplateUuid',
  'serverDescription',
  'excludeFromSubscriptionTypes',
  'pinnedPeerCertSha256',
  'verifyPeerCertByName',
  'keepSniBlank',
  'isHidden',
  'tags',
  'path',
  'host',
  'alpn',
];

const SUBSCRIPTION_SETTINGS_WE_DO_NOT_MODEL = [
  'customRemarks',
  'randomizeHosts',
  'serveJsonAtBaseSubscription',
  'isProfileWebpageUrlEnabled',
  'happAnnounce',
  'happRouting',
  'customResponseHeaders',
  'hwidSettings',
];

// ───── Helpers ─────

function toInbound(i: z.infer<typeof InboundSchema>): SourceInbound {
  const raw = (i.rawInbound ?? {}) as Record<string, unknown>;
  return {
    id: i.uuid,
    tag: i.tag,
    protocol: i.protocol ?? i.type ?? asString(raw.protocol) ?? 'unknown',
    port: i.port ?? (typeof raw.port === 'number' ? raw.port : null),
    network: i.network ?? null,
    security: i.security ?? null,
    serverNames: readServerNames(raw),
    raw: i.rawInbound ?? null,
  };
}

function readServerNames(rawInbound: Record<string, unknown>): string[] {
  const stream = rawInbound.streamSettings;
  if (!stream || typeof stream !== 'object') return [];
  const reality = (stream as Record<string, unknown>).realitySettings;
  if (!reality || typeof reality !== 'object') return [];
  const names = (reality as Record<string, unknown>).serverNames;
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
}

function readRoutingRules(config: Record<string, unknown>): SourceRoutingRule[] {
  const routing = config.routing;
  if (!routing || typeof routing !== 'object') return [];
  const rules = (routing as Record<string, unknown>).rules;
  if (!Array.isArray(rules)) return [];

  return rules.map((rule) => {
    const r = (rule ?? {}) as Record<string, unknown>;
    const route = r.vlessRoute;
    return {
      routeExpr:
        typeof route === 'string' || typeof route === 'number' ? route : null,
      outboundTag: asString(r.outboundTag),
      matches: describeMatch(r),
    };
  });
}

/** One line saying what a rule keys on, so the printed table is readable
 *  without opening their panel next to it. */
function describeMatch(rule: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ['domain', 'ip', 'protocol', 'port', 'network', 'source', 'sourceIP', 'user']) {
    const value = rule[key];
    if (Array.isArray(value) && value.length > 0) {
      const head = value.slice(0, 3).map(String).join(', ');
      parts.push(`${key}: ${head}${value.length > 3 ? ` +${value.length - 3}` : ''}`);
    } else if (typeof value === 'string' && value !== '') {
      parts.push(`${key}: ${value}`);
    }
  }
  return parts.length > 0 ? parts.join('; ') : 'catch-all';
}

function readOutboundTags(config: Record<string, unknown>): string[] {
  const outbounds = config.outbounds;
  if (!Array.isArray(outbounds)) return [];
  return outbounds
    .map((o) => (o && typeof o === 'object' ? asString((o as Record<string, unknown>).tag) : null))
    .filter((tag): tag is string => tag !== null);
}

/**
 * Find every `ext:<file>:<list>` reference in the config.
 *
 * These name data files that live on the source's own nodes. A rule pointing at
 * a file we do not ship does not fail loudly on our side - it matches nothing,
 * so the traffic it was supposed to catch just goes somewhere else.
 */
function readExternalAssets(config: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      const match = /^ext:([^:]+):/.exec(value);
      if (match?.[1]) found.add(match[1]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(config);
  return [...found].sort();
}

/** Pick out the listed keys that are actually SET, stringified for printing.
 *  A field that exists in their model but is null everywhere is not a problem
 *  we need to solve, and reporting it as one wastes the reader's attention. */
function collectSetExtras(record: Record<string, unknown>, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'boolean' && value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && Object.keys(value as object).length === 0) continue;
    if (typeof value === 'string' && value === '') continue;
    out[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return out;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function short(err: unknown): string {
  if (err instanceof SourceHttpError) return `HTTP ${err.status}`;
  return err instanceof Error ? err.message.slice(0, 80) : String(err);
}
