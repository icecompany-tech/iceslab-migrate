/**
 * Turn a source inventory into a report an operator can act on.
 *
 * Pure: inventory in, findings out, no I/O. That is what lets the interesting
 * cases (a contradictory route label, a username our schema rejects) be tested
 * on fixtures instead of only being discovered against a live panel at 3am.
 *
 * The report answers four questions, in this order of usefulness:
 *
 *   1. What would STOP an import (and must be fixed first)?
 *   2. What moves, but loses something on the way?
 *   3. What does not move at all and has to be rebuilt by hand?
 *   4. What looks wrong in the source itself?
 *
 * Point 4 exists because a migration is the first time in years that anybody
 * reads every row. Silently "fixing" what looks odd is how a subscriber who
 * paid for one country quietly ends up in another; the audit prints it and lets
 * a human decide.
 */

import { parseRouteExpr, formatRanges } from './route-expr.js';
import {
  CREDENTIALS_WITH_A_HOME,
  DESCRIPTION_MAX,
  EMAIL_MAX,
  FOREVER_AFTER_YEAR,
  mapStatus,
  mapStrategy,
  REALITY_SERVER_NAMES_MAX,
  SUB_TOKEN_MAX,
  SUB_TOKEN_MIN,
  SUB_TOKEN_PATTERN,
  TAG_MAX,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_PATTERN,
  UUID_PATTERN,
} from '../target/iceslab.js';
import type { SourceHost, SourceInventory, SourceProfile, SourceRef } from '../sources/types.js';

export type Severity = 'blocker' | 'lossy' | 'manual' | 'anomaly' | 'note';

export interface Finding {
  severity: Severity;
  /** Stable identifier. Meant to be greppable across runs and quotable in a
   *  message to the operator ("we are still waiting on host-multi-address"). */
  code: string;
  title: string;
  detail?: string;
  count?: number;
  samples?: string[];
  /** What to do about it. A finding with no action is an observation, and
   *  observations belong in `note`. */
  action?: string;
}

export interface TopologyRow {
  hostId: string;
  remark: string;
  enabled: boolean;
  addresses: string[];
  routeId: number | null;
  profile: string | null;
  inboundTag: string | null;
  /** Outbound tags of the rules whose selector covers this host's route id, in
   *  the order the source evaluates them. */
  outbounds: string[];
  /** Squads that will be able to see this host once exclusions are inverted. */
  squads: string[];
}

export interface RouteCatalogRow {
  routeId: number;
  hostCount: number;
  enabledHostCount: number;
  /** Distinct remark phrases (transport noise stripped) sold on this route. */
  phrases: string[];
  outbounds: string[];
}

export interface SquadHostGrant {
  squad: string;
  /** Hosts this squad will be granted. */
  hostCount: number;
  /** True when the squad sees everything, i.e. we emit NO grant rows and rely
   *  on our "no rows = all hosts" default. */
  seesEverything: boolean;
}

export interface AuditCounts {
  users: number;
  usersByStatus: Record<string, number>;
  usersWithTraffic: number;
  usedTrafficBytes: number;
  lifetimeTrafficBytes: number;
  squads: number;
  hosts: number;
  hostsEnabled: number;
  hostsAfterAddressExpansion: number;
  profiles: number;
  inbounds: number;
  devices: number;
  nodes: number;
  squadMemberships: number;
}

export interface AuditResult {
  ref: SourceRef;
  counts: AuditCounts;
  findings: Finding[];
  topology: TopologyRow[];
  routeCatalog: RouteCatalogRow[];
  squadGrants: SquadHostGrant[];
}

const SAMPLE_LIMIT = 8;

export function auditInventory(inv: SourceInventory): AuditResult {
  const findings: Finding[] = [];

  const inboundIndex = indexInbounds(inv.profiles);
  const topology = buildTopology(inv, inboundIndex);
  const routeCatalog = buildRouteCatalog(inv, topology);
  const squadGrants = buildSquadGrants(inv);

  checkUsers(inv, findings);
  checkCredentials(inv, findings);
  checkTopology(inv, topology, inboundIndex, findings);
  checkRouteLabels(inv, findings);
  checkProfiles(inv, findings);
  checkDevices(inv, findings);
  checkSubscriptionSettings(inv, findings);
  checkDrift(inv, findings);

  return {
    ref: inv.ref,
    counts: countEverything(inv, topology),
    findings: sortFindings(findings),
    topology,
    routeCatalog,
    squadGrants,
  };
}

// ───── Counting ─────

function countEverything(inv: SourceInventory, topology: TopologyRow[]): AuditCounts {
  const usersByStatus: Record<string, number> = {};
  let usedTrafficBytes = 0;
  let lifetimeTrafficBytes = 0;
  let usersWithTraffic = 0;
  let squadMemberships = 0;

  for (const user of inv.users) {
    const key = user.status || '(empty)';
    usersByStatus[key] = (usersByStatus[key] ?? 0) + 1;
    usedTrafficBytes += user.usedTrafficBytes;
    lifetimeTrafficBytes += user.lifetimeUsedTrafficBytes;
    if (user.usedTrafficBytes > 0) usersWithTraffic++;
    squadMemberships += user.squadIds.length;
  }

  return {
    users: inv.users.length,
    usersByStatus,
    usersWithTraffic,
    usedTrafficBytes,
    lifetimeTrafficBytes,
    squads: inv.squads.length,
    hosts: inv.hosts.length,
    hostsEnabled: inv.hosts.filter((h) => h.enabled).length,
    hostsAfterAddressExpansion: topology.reduce((sum, row) => sum + row.addresses.length, 0),
    profiles: inv.profiles.length,
    inbounds: inv.profiles.reduce((sum, p) => sum + p.inbounds.length, 0),
    devices: inv.devices.length,
    nodes: inv.nodes.length,
    squadMemberships,
  };
}

// ───── Users ─────

function checkUsers(inv: SourceInventory, out: Finding[]): void {
  const badUsernames: string[] = [];
  const badTokens: string[] = [];
  const badVlessUuids: string[] = [];
  const unmappableStatus = new Map<string, number>();
  const unmappableStrategy = new Map<string, number>();
  const overlongText: string[] = [];
  const foreverExpiry: string[] = [];
  const zeroLimit: string[] = [];
  const partialGbLimit: string[] = [];

  const usernameSeen = new Map<string, string[]>();
  const tokenSeen = new Map<string, string[]>();
  const telegramSeen = new Map<string, string[]>();

  for (const user of inv.users) {
    if (
      !USERNAME_PATTERN.test(user.username) ||
      user.username.length < USERNAME_MIN ||
      user.username.length > USERNAME_MAX
    ) {
      badUsernames.push(user.username);
    }
    push(usernameSeen, user.username, user.id);

    const token = user.subscriptionToken ?? '';
    if (!SUB_TOKEN_PATTERN.test(token) || token.length < SUB_TOKEN_MIN || token.length > SUB_TOKEN_MAX) {
      badTokens.push(`${user.username} (${token.length} chars)`);
    }
    push(tokenSeen, token, user.username);

    const vless = user.credentials.vless;
    if (vless && !UUID_PATTERN.test(vless)) badVlessUuids.push(user.username);

    if (mapStatus(user.status) === null) {
      unmappableStatus.set(user.status, (unmappableStatus.get(user.status) ?? 0) + 1);
    }
    if (mapStrategy(user.trafficLimitStrategy) === null) {
      const key = user.trafficLimitStrategy || '(empty)';
      unmappableStrategy.set(key, (unmappableStrategy.get(key) ?? 0) + 1);
    }

    if ((user.description?.length ?? 0) > DESCRIPTION_MAX) overlongText.push(`${user.username}: description`);
    if ((user.tag?.length ?? 0) > TAG_MAX) overlongText.push(`${user.username}: tag`);
    if ((user.email?.length ?? 0) > EMAIL_MAX) overlongText.push(`${user.username}: email`);

    if (user.expireAt && user.expireAt.getUTCFullYear() >= FOREVER_AFTER_YEAR) {
      foreverExpiry.push(user.username);
    }
    if (user.trafficLimitBytes === 0) zeroLimit.push(user.username);
    else if (user.trafficLimitBytes % (1024 * 1024 * 1024) !== 0) partialGbLimit.push(user.username);

    if (user.telegramId) push(telegramSeen, user.telegramId, user.username);
  }

  if (badUsernames.length > 0) {
    out.push({
      severity: 'blocker',
      code: 'username-invalid',
      title: 'Usernames our schema will not accept',
      detail:
        `Our rule is ${USERNAME_MIN}-${USERNAME_MAX} characters of letters, digits, underscore ` +
        `and hyphen. These names have something else in them (spaces, dots, Cyrillic, emoji).`,
      count: badUsernames.length,
      samples: sample(badUsernames),
      action:
        'Decide the rewrite rule BEFORE the import (transliterate, strip, or prefix) and apply it ' +
        'consistently - the username is what the operator searches by afterwards.',
    });
  }

  reportDuplicates(out, usernameSeen, {
    code: 'username-duplicate',
    title: 'The same username on more than one account',
    severity: 'blocker',
    detail:
      'Our API refuses a duplicate username (409), so rows written straight to the database ' +
      'would exist but could never be edited through the panel afterwards.',
    action: 'Resolve on the source, or agree a suffix rule for the losers.',
  });

  if (badTokens.length > 0) {
    out.push({
      severity: 'blocker',
      code: 'sub-token-invalid',
      title: 'Subscription tokens outside what we can store',
      detail: `Ours must be ${SUB_TOKEN_MIN}-${SUB_TOKEN_MAX} URL-safe characters.`,
      count: badTokens.length,
      samples: sample(badTokens),
      action:
        'A rewritten token means that subscriber must re-import their link. Count them before ' +
        'the cut-over so support knows how many calls to expect.',
    });
  }

  reportDuplicates(out, tokenSeen, {
    code: 'sub-token-duplicate',
    title: 'The same subscription token on more than one account',
    severity: 'blocker',
    detail: 'The column is unique. Two accounts sharing a token cannot both be imported.',
    action: 'Regenerate one of each pair on the source before the import.',
  });

  if (badVlessUuids.length > 0) {
    out.push({
      severity: 'blocker',
      code: 'vless-uuid-invalid',
      title: 'VLESS ids that are not UUIDs',
      detail: 'Our column is a real uuid type, not free text.',
      count: badVlessUuids.length,
      samples: sample(badVlessUuids),
      action: 'These subscribers need a fresh id, which means re-importing their config.',
    });
  }

  for (const [value, count] of unmappableStatus) {
    out.push({
      severity: 'blocker',
      code: 'status-unmappable',
      title: `Status "${value}" has no equivalent here`,
      count,
      action: 'Choose the status these accounts land on before importing them.',
    });
  }
  for (const [value, count] of unmappableStrategy) {
    out.push({
      severity: 'blocker',
      code: 'strategy-unmappable',
      title: `Traffic reset period "${value}" has no equivalent here`,
      count,
      action: 'Pick the closest of: no_reset, day, week, month, rolling.',
    });
  }

  if (overlongText.length > 0) {
    out.push({
      severity: 'lossy',
      code: 'text-too-long',
      title: 'Description / tag / email longer than our columns',
      count: overlongText.length,
      samples: sample(overlongText),
      action: 'They will be truncated. Fine for a note, not fine for an email.',
    });
  }

  if (foreverExpiry.length > 0) {
    out.push({
      severity: 'note',
      code: 'expiry-means-never',
      title: `Accounts expiring in ${FOREVER_AFTER_YEAR}+ , i.e. "never"`,
      count: foreverExpiry.length,
      action:
        'We can store an open-ended subscription as NULL instead of a fake date. Say which you ' +
        'want; a real date in 2099 will look like a bug to whoever reads it next.',
    });
  }

  if (zeroLimit.length > 0) {
    out.push({
      severity: 'note',
      code: 'traffic-limit-zero',
      title: 'Traffic limit stored as 0, which means unlimited on the source',
      count: zeroLimit.length,
      action: 'Imported as NULL (unlimited). A literal 0 here would mean "no traffic allowed".',
    });
  }

  if (partialGbLimit.length > 0) {
    out.push({
      severity: 'note',
      code: 'traffic-limit-not-whole-gb',
      title: 'Traffic limits that are not a whole number of GiB',
      detail:
        'Our public API takes whole GiB. The importer writes bytes straight to the database, so ' +
        'nothing is lost - but these limits cannot later be re-entered through the API unchanged.',
      count: partialGbLimit.length,
      samples: sample(partialGbLimit),
    });
  }

  const shared = [...telegramSeen.entries()].filter(([, owners]) => owners.length > 1);
  if (shared.length > 0) {
    const worst = shared.reduce((a, b) => (b[1].length > a[1].length ? b : a));
    out.push({
      severity: 'anomaly',
      code: 'telegram-id-shared',
      title: 'One Telegram id on several accounts',
      detail:
        `${shared.length} ids are shared; the busiest covers ${worst[1].length} accounts. ` +
        'Whatever the reason (families, resale, an old import), nothing may treat a Telegram id ' +
        'as identifying one account.',
      count: shared.length,
      samples: sample(shared.map(([id, owners]) => `${id}: ${owners.length} accounts`)),
      action: 'Confirm with the operator what the bot should do when an id resolves to several people.',
    });
  }
}

function checkCredentials(inv: SourceInventory, out: Finding[]): void {
  const homeless = new Map<string, number>();
  for (const user of inv.users) {
    for (const kind of Object.keys(user.credentials)) {
      if (!CREDENTIALS_WITH_A_HOME.has(kind)) {
        homeless.set(kind, (homeless.get(kind) ?? 0) + 1);
      }
    }
  }
  if (homeless.size === 0) return;

  // A credential nobody can use is not a loss worth alarming about. Check
  // whether any inbound actually speaks that protocol before calling it one.
  const protocolsInUse = new Set(
    inv.profiles.flatMap((p) => p.inbounds.map((i) => i.protocol.toLowerCase())),
  );

  for (const [kind, count] of homeless) {
    const used = protocolsInUse.has(kind) || (kind === 'shadowsocks' && protocolsInUse.has('ss'));
    out.push({
      severity: used ? 'blocker' : 'note',
      code: `credential-no-home-${kind}`,
      title: `${kind} secrets have no column here`,
      detail: used
        ? `An inbound on the source serves ${kind}, so these subscribers have working ${kind} ` +
          'links today. After the move those links stop working.'
        : `No inbound on the source serves ${kind}, so the value is carried by their model but ` +
          'not actually handed to anyone. Dropping it changes nothing for subscribers.',
      count,
      action: used
        ? `Either add a ${kind} credential column before the move, or accept that these ` +
          'subscribers re-import.'
        : undefined,
    });
  }
}

// ───── Topology ─────

interface InboundIndex {
  byInboundId: Map<string, { profile: SourceProfile; tag: string; serverNames: string[] }>;
}

function indexInbounds(profiles: SourceProfile[]): InboundIndex {
  const byInboundId = new Map<string, { profile: SourceProfile; tag: string; serverNames: string[] }>();
  for (const profile of profiles) {
    for (const inbound of profile.inbounds) {
      byInboundId.set(inbound.id, { profile, tag: inbound.tag, serverNames: inbound.serverNames });
    }
  }
  return { byInboundId };
}

function buildTopology(inv: SourceInventory, index: InboundIndex): TopologyRow[] {
  const squadNames = new Map(inv.squads.map((s) => [s.id, s.name]));

  return inv.hosts.map((host) => {
    const linked = host.inboundId ? index.byInboundId.get(host.inboundId) : undefined;
    const allowedSquads = inv.squads
      .filter((s) => !host.excludedSquadIds.includes(s.id))
      .map((s) => s.name);

    return {
      hostId: host.id,
      remark: host.remark,
      enabled: host.enabled,
      addresses: splitAddresses(host.address),
      routeId: host.routeId,
      profile: linked?.profile.name ?? null,
      inboundTag: linked?.tag ?? null,
      outbounds: linked ? outboundsForRoute(linked.profile, host.routeId) : [],
      squads: allowedSquads.length === squadNames.size ? ['(all)'] : allowedSquads,
    };
  });
}

/** The source stores several addresses in one string; its subscription output
 *  turns them into one line each, so our N hosts reproduce it exactly. */
function splitAddresses(address: string): string[] {
  return address
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '');
}

function outboundsForRoute(profile: SourceProfile, routeId: number | null): string[] {
  if (routeId === null) return [];
  const tags: string[] = [];
  for (const rule of profile.routingRules) {
    const parsed = parseRouteExpr(rule.routeExpr);
    if (!parsed.ok) continue;
    if (parsed.selector.covers(routeId) && rule.outboundTag && !tags.includes(rule.outboundTag)) {
      tags.push(rule.outboundTag);
    }
  }
  return tags;
}

function buildRouteCatalog(inv: SourceInventory, topology: TopologyRow[]): RouteCatalogRow[] {
  const byRoute = new Map<number, TopologyRow[]>();
  for (const row of topology) {
    if (row.routeId === null) continue;
    const bucket = byRoute.get(row.routeId) ?? [];
    bucket.push(row);
    byRoute.set(row.routeId, bucket);
  }

  return [...byRoute.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([routeId, rows]) => ({
      routeId,
      hostCount: rows.length,
      enabledHostCount: rows.filter((r) => r.enabled).length,
      phrases: [...new Set(rows.map((r) => remarkPhrase(r.remark)))].filter((p) => p !== ''),
      outbounds: [...new Set(rows.flatMap((r) => r.outbounds))],
    }));
}

function buildSquadGrants(inv: SourceInventory): SquadHostGrant[] {
  // Their model: a host lists the squads DENIED it. Ours: a squad lists the
  // hosts it grants, and no rows means "everything". Inverting per squad (not
  // per host) is what keeps that default intact for squads that see the lot.
  return inv.squads.map((squad) => {
    const allowed = inv.hosts.filter((h) => !h.excludedSquadIds.includes(squad.id));
    return {
      squad: squad.name,
      hostCount: allowed.length,
      seesEverything: allowed.length === inv.hosts.length,
    };
  });
}

function checkTopology(
  inv: SourceInventory,
  topology: TopologyRow[],
  index: InboundIndex,
  out: Finding[],
): void {
  const multiAddress = topology.filter((row) => row.addresses.length > 1);
  if (multiAddress.length > 0) {
    const extra = multiAddress.reduce((sum, row) => sum + row.addresses.length - 1, 0);
    out.push({
      severity: 'note',
      code: 'host-multi-address',
      title: 'Hosts carrying several addresses in one record',
      detail:
        `Their subscription already renders one line per address, so ${multiAddress.length} ` +
        `hosts become ${multiAddress.length + extra} of ours and the subscriber sees the same ` +
        'list as before.',
      count: multiAddress.length,
      samples: sample(multiAddress.map((r) => `${r.remark}: ${r.addresses.length} addresses`)),
    });
  }

  const sniDerived = inv.hosts.filter((h) => h.sniFromAddress);
  const sniDerivedExpanding = sniDerived.filter((h) => splitAddresses(h.address).length > 1);
  if (sniDerived.length > 0) {
    out.push({
      severity: 'note',
      code: 'host-sni-from-address',
      title: 'Hosts that take their TLS name from whichever address was dialled',
      detail:
        `${sniDerived.length} hosts do this` +
        (sniDerivedExpanding.length > 0
          ? `, and ${sniDerivedExpanding.length} of them carry several addresses.`
          : '.'),
      count: sniDerived.length,
      action:
        'When one of those becomes several hosts here, each must get the name of ITS OWN address. ' +
        'Copying the first one to all of them leaves a REALITY handshake that fails on every ' +
        'line but the first.',
    });
  }

  const orphans = inv.hosts.filter((h) => !h.inboundId || !index.byInboundId.has(h.inboundId));
  if (orphans.length > 0) {
    out.push({
      severity: 'blocker',
      code: 'host-orphan-inbound',
      title: 'Hosts pointing at an inbound that is not in any profile',
      detail: 'There is nothing to attach these to on our side.',
      count: orphans.length,
      samples: sample(orphans.map((h) => h.remark)),
      action: 'Check on the source whether these are leftovers that can simply be skipped.',
    });
  }

  const unrouted = topology.filter(
    (row) => row.routeId !== null && row.profile !== null && row.outbounds.length === 0,
  );
  if (unrouted.length > 0) {
    out.push({
      severity: 'anomaly',
      code: 'host-route-unrouted',
      title: 'Hosts whose route id no rule covers',
      detail:
        'Traffic tagged with this id falls through to whatever the profile does last. Worth ' +
        'knowing before it becomes our behaviour rather than theirs.',
      count: unrouted.length,
      samples: sample(unrouted.map((r) => `${r.remark} (route ${r.routeId})`)),
    });
  }

  const noRoute = inv.hosts.filter((h) => h.routeId === null);
  if (noRoute.length > 0) {
    out.push({
      severity: 'note',
      code: 'host-without-route',
      title: 'Hosts with no route id at all',
      count: noRoute.length,
      samples: sample(noRoute.map((h) => h.remark)),
    });
  }

  const disabled = inv.hosts.filter((h) => !h.enabled);
  if (disabled.length > 0) {
    out.push({
      severity: 'note',
      code: 'host-disabled',
      title: 'Hosts switched off on the source',
      count: disabled.length,
      samples: sample(disabled.map((h) => h.remark)),
      action: 'Say whether these are spares worth carrying over or dead weight to leave behind.',
    });
  }

  const droppedSettings = new Map<string, number>();
  for (const host of inv.hosts) {
    for (const key of Object.keys(host.unmappedSettings)) {
      droppedSettings.set(key, (droppedSettings.get(key) ?? 0) + 1);
    }
  }
  if (droppedSettings.size > 0) {
    out.push({
      severity: 'lossy',
      code: 'host-settings-dropped',
      title: 'Per-host settings we do not model',
      detail: [...droppedSettings.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `${key} (${count} hosts)`)
        .join(', '),
      count: droppedSettings.size,
      action: 'Check each against the subscriber-visible result; most of these change what a client dials.',
    });
  }
}

/**
 * The same product sold on two different routes.
 *
 * Derived, not guessed: strip transport noise from each host's label, then look
 * for a label that appears under more than one route id. On live data this
 * caught a host labelled as the ad-free tier sitting on the with-ads route -
 * the kind of thing that is invisible until a subscriber complains that the
 * thing they pay extra for stopped working.
 */
function checkRouteLabels(inv: SourceInventory, out: Finding[]): void {
  const byPhrase = new Map<string, Set<number>>();
  for (const host of inv.hosts) {
    if (host.routeId === null) continue;
    const phrase = remarkPhrase(host.remark);
    if (phrase === '') continue;
    const bucket = byPhrase.get(phrase) ?? new Set<number>();
    bucket.add(host.routeId);
    byPhrase.set(phrase, bucket);
  }

  const contradictions = [...byPhrase.entries()].filter(([, routes]) => routes.size > 1);
  if (contradictions.length === 0) return;

  out.push({
    severity: 'anomaly',
    code: 'route-label-contradiction',
    title: 'The same host label on more than one route',
    detail:
      'Two hosts described identically send traffic out different ways. Either the label is ' +
      'wrong or the route is, and a migration that copies both faithfully carries the mistake.',
    count: contradictions.length,
    samples: sample(
      contradictions.map(([phrase, routes]) => `"${phrase}" -> routes ${[...routes].sort((a, b) => a - b).join(', ')}`),
    ),
    action: 'Ask which is right before the import; afterwards it looks like our bug.',
  });
}

const TRANSPORT_NOISE = new Set([
  'xhttp', 'grpc', 'h2', 'h3', 'ws', 'tcp', 'quic', 'kcp', 'http', 'httpupgrade', 'splithttp',
  'reality', 'tls', 'xtls', 'vless', 'vmess', 'trojan', 'ss', 'shadowsocks', 'hysteria', 'hy2',
]);

/** Label with transport and protocol words removed, so "🇨🇭 Switzerland No Ads
 *  [V] H2" and "🇨🇭 Switzerland No Ads XHTTP" compare equal - they are the same
 *  product on two transports. */
export function remarkPhrase(remark: string): string {
  return remark
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== '' && !TRANSPORT_NOISE.has(token))
    .join(' ')
    .trim();
}

// ───── Profiles ─────

function checkProfiles(inv: SourceInventory, out: Finding[]): void {
  const overLimit: string[] = [];
  const exotic = new Map<string, number>();

  for (const profile of inv.profiles) {
    for (const inbound of profile.inbounds) {
      if (inbound.serverNames.length > REALITY_SERVER_NAMES_MAX) {
        overLimit.push(`${profile.name}/${inbound.tag}: ${inbound.serverNames.length} names`);
      }
      const protocol = inbound.protocol.toLowerCase();
      if (protocol === 'hysteria' || protocol === 'hysteria2') {
        exotic.set(protocol, (exotic.get(protocol) ?? 0) + 1);
      }
    }
  }

  if (overLimit.length > 0) {
    out.push({
      severity: 'blocker',
      code: 'reality-server-names-over-limit',
      title: `REALITY masquerade lists longer than our cap of ${REALITY_SERVER_NAMES_MAX}`,
      detail:
        'Import would either truncate the list silently - quietly weakening the masquerade the ' +
        'operator chose - or fail validation.',
      count: overLimit.length,
      samples: sample(overLimit),
      action: 'Raise the cap in the panel schema before importing. It is a one-line change.',
    });
  }

  if (exotic.size > 0) {
    out.push({
      severity: 'manual',
      code: 'inbound-not-stock',
      title: 'Inbounds a stock engine will not load',
      detail:
        [...exotic.entries()].map(([p, c]) => `${p}: ${c}`).join(', ') +
        '. These live inside the engine config on the source; here that protocol is a separate ' +
        'daemon with its own settings.',
      count: [...exotic.values()].reduce((a, b) => a + b, 0),
      action: 'Confirm whether these are actually served to subscribers or are test leftovers.',
    });
  }

  const rules = inv.profiles.reduce((sum, p) => sum + p.routingRules.length, 0);
  const outbounds = new Set(inv.profiles.flatMap((p) => p.outboundTags));
  if (rules > 0 || outbounds.size > 0) {
    out.push({
      severity: 'manual',
      code: 'routing-not-converted',
      title: 'Routing, outbounds and DNS are not converted',
      detail:
        `${rules} rules and ${outbounds.size} outbound tags across ${inv.profiles.length} profiles` +
        `${inv.profiles.some((p) => p.hasDnsSection) ? ', plus a DNS section' : ''}. ` +
        'Expressing these in our model is a panel feature, not a migration step, and pretending ' +
        'otherwise would deliver neither.',
      count: rules,
      samples: sample([...outbounds]),
      action: 'The table below is for rebuilding this by hand, once.',
    });
  }

  const assets = new Set(inv.profiles.flatMap((p) => p.externalAssets));
  if (assets.size > 0) {
    out.push({
      severity: 'manual',
      code: 'external-assets',
      title: 'Rules referencing data files we do not ship',
      detail:
        'A rule pointing at a missing file does not error - it matches nothing, so the traffic ' +
        'it was meant to catch quietly goes elsewhere.',
      count: assets.size,
      samples: [...assets],
      action: 'Get the files and their update procedure from the operator.',
    });
  }
}

// ───── Devices ─────

function checkDevices(inv: SourceInventory, out: Finding[]): void {
  if (inv.devices.length === 0) return;

  const knownUsers = new Set(inv.users.map((u) => u.id));
  const orphans = inv.users.length > 0 ? inv.devices.filter((d) => !knownUsers.has(d.userId)) : [];

  const extraKeys = new Map<string, number>();
  for (const device of inv.devices) {
    for (const key of Object.keys(device.extra)) {
      extraKeys.set(key, (extraKeys.get(key) ?? 0) + 1);
    }
  }

  out.push({
    severity: 'lossy',
    code: 'device-metadata-dropped',
    title: 'Device bindings move, their descriptions do not',
    detail:
      extraKeys.size > 0
        ? `We keep the hardware id and the dates. No columns for: ` +
          [...extraKeys.keys()].sort().join(', ') +
          '. A readable summary can go into the device label instead.'
        : 'We keep the hardware id and the dates.',
    count: inv.devices.length,
    action:
      'Worth carrying: without it, everyone near their device limit hits it again on day one.',
  });

  if (orphans.length > 0) {
    out.push({
      severity: 'anomaly',
      code: 'device-orphan',
      title: 'Devices bound to accounts that no longer exist',
      count: orphans.length,
      action: 'Skipped on import unless you say otherwise.',
    });
  }
}

// ───── Subscription settings ─────

function checkSubscriptionSettings(inv: SourceInventory, out: Finding[]): void {
  const settings = inv.subscriptionSettings;
  if (!settings) {
    out.push({
      severity: 'note',
      code: 'subscription-settings-unread',
      title: 'Subscription settings could not be read',
      action: 'Check the token has the right scope; otherwise these are re-entered by hand.',
    });
    return;
  }

  const unsupported = Object.keys(settings.unsupported);
  if (unsupported.length > 0) {
    out.push({
      severity: 'manual',
      code: 'subscription-settings-unsupported',
      title: 'Subscription settings we have no equivalent for',
      detail: unsupported.sort().join(', '),
      count: unsupported.length,
      action:
        'Read these before dismissing them: the texts a client shows when there are no servers ' +
        'are the difference between "subscription expired" and an empty screen.',
    });
  }

  if (settings.responseRules.length > 0) {
    out.push({
      severity: 'note',
      code: 'client-detection-rules',
      title: 'Client-detection rules to compare against ours',
      detail: settings.responseRules.map((r) => r.name).join(', '),
      count: settings.responseRules.length,
      action:
        'A client we fail to recognise gets the fallback format instead of its own, which looks ' +
        'to the subscriber like the import broke their app.',
    });
  }
}

// ───── Version drift ─────

function checkDrift(inv: SourceInventory, out: Finding[]): void {
  const entries = Object.entries(inv.unreadFields).filter(([, keys]) => keys.length > 0);
  if (entries.length === 0) return;

  out.push({
    severity: 'note',
    code: 'source-fields-not-read',
    title: 'Fields the source sends that this tool ignores',
    detail: entries.map(([entity, keys]) => `${entity}: ${keys.join(', ')}`).join(' | '),
    count: entries.reduce((sum, [, keys]) => sum + keys.length, 0),
    action:
      'Mostly harmless (view positions, timestamps). Worth a glance after a source upgrade: this ' +
      'is where a field that started mattering would first show up.',
  });
}

// ───── Small helpers ─────

function push(map: Map<string, string[]>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

function reportDuplicates(
  out: Finding[],
  seen: Map<string, string[]>,
  meta: { code: string; title: string; severity: Severity; detail: string; action: string },
): void {
  const dupes = [...seen.entries()].filter(([key, owners]) => key !== '' && owners.length > 1);
  if (dupes.length === 0) return;
  out.push({
    severity: meta.severity,
    code: meta.code,
    title: meta.title,
    detail: meta.detail,
    count: dupes.length,
    samples: sample(dupes.map(([key, owners]) => `${key} (${owners.length})`)),
    action: meta.action,
  });
}

function sample(values: string[]): string[] {
  return values.slice(0, SAMPLE_LIMIT);
}

const SEVERITY_ORDER: Record<Severity, number> = {
  blocker: 0,
  manual: 1,
  lossy: 2,
  anomaly: 3,
  note: 4,
};

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code),
  );
}

export { formatRanges };
