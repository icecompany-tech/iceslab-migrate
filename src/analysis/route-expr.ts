/**
 * Route selectors: the little expression language a source panel uses to say
 * which route ids a routing rule applies to.
 *
 * Observed forms, all from live data:
 *
 *   11              a single id (as a JSON number)
 *   "11"            the same, as a string
 *   "11-19"         an inclusive range
 *   "2-9,12-19,99"  a comma-separated list of ids and ranges
 *
 * Why this file is separate and tested to death: the id encodes which country
 * a paying subscriber comes out of. Reading "2-9" as "2 and 9" instead of
 * "2 through 9" does not crash anything - it produces a migration where people
 * quietly exit in the wrong country. That is the exact failure class that cost
 * us both cascade entries once already, and it came from a string nobody
 * checked against the consumer that parses it.
 *
 * Parsing never throws. A selector we cannot read is a finding to report, not a
 * reason to abandon an audit of 30 000 users.
 */

export interface RouteSelector {
  /** Verbatim source text, for the report. */
  raw: string;
  /** Inclusive ranges, normalised and sorted. A single id is [n, n]. */
  ranges: [number, number][];
  /** Does this selector cover `id`? */
  covers(id: number): boolean;
  /** Every id covered, ascending. Bounded by `maxSize`; returns null when the
   *  selector is wider than that (nothing real is, but a typo could be). */
  expand(maxSize?: number): number[] | null;
}

export type RouteExprResult =
  | { ok: true; selector: RouteSelector }
  | { ok: false; raw: string; error: string };

const MAX_ID = 65_535; // route tags ride in two bytes of the user's UUID

export function parseRouteExpr(input: string | number | null | undefined): RouteExprResult {
  if (input === null || input === undefined || input === '') {
    return { ok: false, raw: String(input ?? ''), error: 'empty selector' };
  }

  const raw = String(input).trim();
  if (raw === '') return { ok: false, raw, error: 'empty selector' };

  const ranges: [number, number][] = [];

  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (piece === '') {
      return { ok: false, raw, error: `empty element in list ("${raw}")` };
    }

    // A leading minus would be a negative number, which route ids never are;
    // treating "-5" as a range with a missing start is the reading that catches
    // a typo instead of silently accepting it.
    const dash = piece.indexOf('-');
    if (dash === -1) {
      const single = toId(piece);
      if (single === null) return { ok: false, raw, error: `"${piece}" is not a route id` };
      ranges.push([single, single]);
      continue;
    }

    const lo = toId(piece.slice(0, dash).trim());
    const hi = toId(piece.slice(dash + 1).trim());
    if (lo === null || hi === null) {
      return { ok: false, raw, error: `"${piece}" is not a valid range` };
    }
    if (lo > hi) {
      // Reversed bounds are a mistake worth naming: a source that means 19..11
      // is a source whose author typed it backwards.
      return { ok: false, raw, error: `range "${piece}" runs backwards` };
    }
    ranges.push([lo, hi]);
  }

  return { ok: true, selector: makeSelector(raw, normalise(ranges)) };
}

function toId(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ID) return null;
  return value;
}

/** Sort and merge touching/overlapping ranges so `covers` is a simple scan and
 *  the report shows one interval instead of three abutting ones. */
function normalise(ranges: [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1] + 1) {
      if (hi > last[1]) last[1] = hi;
    } else {
      merged.push([lo, hi]);
    }
  }
  return merged;
}

function makeSelector(raw: string, ranges: [number, number][]): RouteSelector {
  return {
    raw,
    ranges,
    covers(id: number) {
      return ranges.some(([lo, hi]) => id >= lo && id <= hi);
    },
    expand(maxSize = 1024) {
      let size = 0;
      for (const [lo, hi] of ranges) size += hi - lo + 1;
      if (size > maxSize) return null;
      const out: number[] = [];
      for (const [lo, hi] of ranges) {
        for (let i = lo; i <= hi; i++) out.push(i);
      }
      return out;
    },
  };
}

/** Render normalised ranges back to the source's own notation. Used in the
 *  report so an operator can match a line against their panel by eye. */
export function formatRanges(ranges: [number, number][]): string {
  return ranges.map(([lo, hi]) => (lo === hi ? String(lo) : `${lo}-${hi}`)).join(',');
}
