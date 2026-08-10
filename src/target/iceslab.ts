/**
 * What Iceslab will accept.
 *
 * Every constant here mirrors a rule that lives in the panel. The path in the
 * comment is where the real one is: when a check in this file starts arguing
 * with the panel, the panel wins and this file is the thing to fix.
 *
 * These are duplicated rather than imported because the migrator ships as a
 * standalone tool an operator runs before they have our source tree. The cost
 * of the copy is drift, and the mitigation is that each constant is named,
 * sourced, and exercised by the audit against real data - so drift surfaces as
 * a report that disagrees with an import, not as a silent truncation.
 */

/** apps/panel-backend/src/modules/users/users.schemas.ts - UsernameSchema */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 64;

/** apps/panel-backend/src/modules/users/users.schemas.ts - CreateUserSchema */
export const SUB_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
export const SUB_TOKEN_MIN = 8;
export const SUB_TOKEN_MAX = 64;

/** apps/panel-backend/src/modules/users/users.schemas.ts - UserStatus */
export const USER_STATUSES = ['active', 'disabled', 'expired', 'limited'] as const;

/** apps/panel-backend/src/modules/users/users.schemas.ts - TrafficLimitStrategy */
export const TRAFFIC_STRATEGIES = ['no_reset', 'day', 'week', 'month', 'rolling'] as const;

/** apps/panel-backend/src/modules/inbounds/inbounds.schemas.ts
 *  Raised 8 -> 32 on 2026-08-10 after the first audit of a real incoming panel
 *  found inbounds with 21 names. Keep in step with the panel or the audit will
 *  cheerfully clear an import that then fails validation. */
export const REALITY_SERVER_NAMES_MAX = 32;
export const REALITY_SHORT_IDS_MAX = 8;

/** prisma/schema.prisma - User */
export const DESCRIPTION_MAX = 1000;
export const TAG_MAX = 64;
export const EMAIL_MAX = 255;

/**
 * Credential columns that exist on our User row.
 *
 * `vless` lands in `xray_uuid`. `trojan` and `shadowsocks` have NO column: a
 * source that hands out trojan or shadowsocks links today would leave those
 * subscribers with a dead config after the move, so the audit has to say so out
 * loud rather than let the importer drop two of three secrets in silence.
 */
export const CREDENTIALS_WITH_A_HOME = new Set(['vless']);

/** prisma/schema.prisma - User.xray_uuid is a real uuid column, not text. */
export const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Status names, source-side -> ours. Source values are upper-cased by
 *  convention on the panels we have seen; comparison is case-insensitive. */
export const STATUS_MAP: Record<string, (typeof USER_STATUSES)[number]> = {
  active: 'active',
  disabled: 'disabled',
  limited: 'limited',
  expired: 'expired',
};

/** Reset-period names, source-side -> ours. */
export const STRATEGY_MAP: Record<string, (typeof TRAFFIC_STRATEGIES)[number]> = {
  no_reset: 'no_reset',
  day: 'day',
  week: 'week',
  month: 'month',
  month_rolling: 'rolling',
  rolling: 'rolling',
};

export function mapStatus(sourceStatus: string): string | null {
  return STATUS_MAP[sourceStatus.trim().toLowerCase()] ?? null;
}

export function mapStrategy(sourceStrategy: string): string | null {
  if (sourceStrategy.trim() === '') return 'no_reset';
  return STRATEGY_MAP[sourceStrategy.trim().toLowerCase()] ?? null;
}

/**
 * An expiry this far out means "never" on panels that have no null.
 *
 * Not a hard rule, just the threshold at which the audit says "these N users
 * are marked as expiring in 2099, which is a convention, not a date" - so the
 * operator decides whether they become open-ended subscriptions here.
 */
export const FOREVER_AFTER_YEAR = 2090;
