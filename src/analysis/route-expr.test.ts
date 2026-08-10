import { describe, expect, it } from 'vitest';
import { formatRanges, parseRouteExpr } from './route-expr.js';

function sel(input: string | number) {
  const parsed = parseRouteExpr(input);
  if (!parsed.ok) throw new Error(`expected "${input}" to parse, got: ${parsed.error}`);
  return parsed.selector;
}

describe('parseRouteExpr', () => {
  it('reads a bare number the way the source stores it', () => {
    expect(sel(11).ranges).toEqual([[11, 11]]);
    expect(sel('11').ranges).toEqual([[11, 11]]);
  });

  it('reads a range as inclusive on both ends', () => {
    // The whole point: "11-19" is nine ids, not two. Getting this wrong routes
    // paying subscribers out of the wrong country without erroring anywhere.
    const s = sel('11-19');
    expect(s.expand()).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(s.covers(11)).toBe(true);
    expect(s.covers(15)).toBe(true);
    expect(s.covers(19)).toBe(true);
    expect(s.covers(10)).toBe(false);
    expect(s.covers(20)).toBe(false);
  });

  it('reads a mixed list, which is the form their live config uses', () => {
    const s = sel('2-9,12-19,99');
    expect(s.covers(2)).toBe(true);
    expect(s.covers(9)).toBe(true);
    expect(s.covers(10)).toBe(false);
    expect(s.covers(11)).toBe(false);
    expect(s.covers(12)).toBe(true);
    expect(s.covers(19)).toBe(true);
    expect(s.covers(99)).toBe(true);
    expect(s.covers(98)).toBe(false);
  });

  it('tolerates whitespace around elements', () => {
    expect(sel(' 98 , 99 ').covers(98)).toBe(true);
    expect(sel('11 - 19').covers(15)).toBe(true);
  });

  it('merges overlapping and touching ranges', () => {
    expect(formatRanges(sel('1-3,4-6').ranges)).toBe('1-6');
    expect(formatRanges(sel('1-5,3-9').ranges)).toBe('1-9');
    expect(formatRanges(sel('99,1-3,2').ranges)).toBe('1-3,99');
  });

  it('round-trips single ids without inventing a range', () => {
    expect(formatRanges(sel('11,13,15').ranges)).toBe('11,13,15');
  });

  it('refuses a backwards range instead of quietly matching nothing', () => {
    const parsed = parseRouteExpr('19-11');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('backwards');
  });

  it('refuses garbage rather than treating it as id 0', () => {
    for (const bad of ['', 'abc', '1,,2', '1-', '-1', '1-abc', '1.5', ' ']) {
      expect(parseRouteExpr(bad).ok, `"${bad}" must not parse`).toBe(false);
    }
  });

  it('refuses ids that cannot fit the two bytes carried in a UUID', () => {
    expect(parseRouteExpr('65535').ok).toBe(true);
    expect(parseRouteExpr('65536').ok).toBe(false);
  });

  it('declines to expand an absurdly wide selector instead of allocating it', () => {
    expect(sel('1-65535').expand(1024)).toBeNull();
    expect(sel('1-65535').covers(40_000)).toBe(true);
  });

  it('treats null and undefined as a missing selector, not as id 0', () => {
    expect(parseRouteExpr(null).ok).toBe(false);
    expect(parseRouteExpr(undefined).ok).toBe(false);
  });
});
