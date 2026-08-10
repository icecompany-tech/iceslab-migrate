/**
 * What every source panel must be able to hand over.
 *
 * Deliberately small and shaped by what a MIGRATION needs, not by what any one
 * panel happens to store: the second adapter (3x-ui) fills the same shape, and
 * everything downstream - audit, import, delta - only ever sees this.
 *
 * Read-only by construction. There is no write method anywhere in this file and
 * none must ever be added: an importer that cannot write to the source cannot
 * damage a live service the operator is still selling from. That guarantee is
 * worth more than any convenience a write method would buy.
 */

/** Where a value came from, for provenance and for repeatable re-runs. */
export interface SourceRef {
  /** Panel kind, e.g. "remnawave". Appears in reports and in `sourceId`. */
  kind: string;
  /** Base URL the inventory was read from. Never contains the token. */
  url: string;
  /** Operator-facing brand of the source panel, when it exposes one. */
  brand?: string | undefined;
}

export interface SourceUser {
  /** Stable id in the source. Becomes our `sourceId`, which is what makes a
   *  second run an update instead of a duplicate. */
  id: string;
  username: string;
  /** Subscription token as the subscriber's client has it today. Carrying this
   *  over is the difference between "clients keep working" and "29 865 people
   *  re-import by hand". */
  subscriptionToken: string;
  /** Source status verbatim, un-normalised. The audit reports what it maps to;
   *  normalising here would hide values we have no home for. */
  status: string;
  /** Absolute instant, not a span. Null = never expires. */
  expireAt: Date | null;
  trafficLimitBytes: number;
  /** Source strategy verbatim, same reasoning as `status`. */
  trafficLimitStrategy: string;
  usedTrafficBytes: number;
  lifetimeUsedTrafficBytes: number;
  lastTrafficResetAt: Date | null;
  subRevokedAt: Date | null;
  telegramId: string | null;
  email: string | null;
  description: string | null;
  tag: string | null;
  hwidDeviceLimit: number | null;
  createdAt: Date | null;
  /** Credentials, keyed by protocol family. A user whose credentials change on
   *  migration has to re-import their config, which is the one thing an operator
   *  cannot ask 29 865 people to do on a Tuesday. */
  credentials: Record<string, string>;
  /** Squad ids this user belongs to. */
  squadIds: string[];
}

export interface SourceSquad {
  id: string;
  name: string;
  /** Members are carried on the user, this is only for squads that are empty
   *  (they still have to exist after the move). */
  memberCount: number | null;
}

export interface SourceHost {
  id: string;
  /** Operator-facing label. On the source this is also what the subscriber
   *  sees in their client, so its wording is evidence about intent. */
  remark: string;
  /** Verbatim address field. May be a comma-separated list: on the source one
   *  host with N addresses shows up as N lines in the subscription. */
  address: string;
  port: number | null;
  sni: string | null;
  fingerprint: string | null;
  /** Route selector encoded into the user's UUID. Our `routeTag` is the same
   *  mechanism, so this must survive the move byte for byte. */
  routeId: number | null;
  enabled: boolean;
  /** Id of the inbound this host publishes. */
  inboundId: string | null;
  /** The source derives the TLS name from whichever address the client dialled.
   *  Combined with a multi-address host that is their fan-out mechanism, and it
   *  dictates how the expansion must be done here: each of our hosts needs the
   *  SNI of ITS address, not of the first one. */
  sniFromAddress: boolean;
  /** Client-side TLS behaviour we do model, carried so the audit can say it
   *  survives rather than leaving the reader to wonder. */
  securityLayer: string | null;
  allowInsecure: boolean;
  /** Squads explicitly DENIED this host. Our model is the inverse (a squad
   *  lists what it grants), so this needs inverting, not copying. */
  excludedSquadIds: string[];
  /** Fields the source has set that our model has no home for. Key -> value,
   *  already stringified for the report. */
  unmappedSettings: Record<string, string>;
}

export interface SourceInbound {
  id: string;
  tag: string;
  protocol: string;
  port: number | null;
  network: string | null;
  security: string | null;
  /** REALITY masquerade names. Length matters: our schema caps the list. */
  serverNames: string[];
  /** Whole inbound as the source stores it, for the parts we only print. */
  raw: unknown;
}

export interface SourceProfile {
  id: string;
  name: string;
  inbounds: SourceInbound[];
  /** Routing rules, outbound tags and the dns section, when the source keeps a
   *  whole engine config per profile. We do not convert these; the audit prints
   *  them so a human can reproduce them once. */
  routingRules: SourceRoutingRule[];
  outboundTags: string[];
  hasDnsSection: boolean;
  /** External data files the rules reference (`ext:geosite_RU.dat:...`). Rules
   *  that name a file we do not ship silently match nothing. */
  externalAssets: string[];
}

export interface SourceRoutingRule {
  /** Route selector expression: a number, a range ("11-19") or a list
   *  ("2-9,12-19,99"). Kept verbatim; parsing lives in analysis/route-expr. */
  routeExpr: string | number | null;
  outboundTag: string | null;
  /** Short human summary of what the rule matches on, for the printed table. */
  matches: string;
}

export interface SourceDevice {
  userId: string;
  hwid: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  /** platform / deviceModel / osVersion / userAgent and anything else the
   *  source keeps per device. We have no columns for these. */
  extra: Record<string, string>;
}

export interface SourceNode {
  id: string;
  name: string;
  address: string | null;
  raw: unknown;
}

export interface SourceSubscriptionSettings {
  profileTitle: string | null;
  supportLink: string | null;
  updateIntervalHours: number | null;
  /** Client-detection rules. We have an equivalent (SRR); the audit compares
   *  coverage rather than assuming ours is a superset. */
  responseRules: { name: string; pattern: string }[];
  /** Settings the source has that we do not model at all. */
  unsupported: Record<string, string>;
}

export interface SourceInventory {
  ref: SourceRef;
  users: SourceUser[];
  squads: SourceSquad[];
  hosts: SourceHost[];
  profiles: SourceProfile[];
  devices: SourceDevice[];
  nodes: SourceNode[];
  subscriptionSettings: SourceSubscriptionSettings | null;
  /** Response keys the adapter saw but does not read, per entity. A source that
   *  grew a field since this adapter was written shows up here, which is how a
   *  version mismatch becomes visible instead of becoming silent data loss. */
  unreadFields: Record<string, string[]>;
}

export interface SourceAdapter {
  readonly kind: string;
  /** Pull everything the migration cares about. Read-only. */
  collect(progress: (msg: string) => void): Promise<SourceInventory>;
}
