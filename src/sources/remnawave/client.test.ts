import { describe, expect, it, vi } from 'vitest';
import { asList, fetchAllPaged, unwrapEnvelope, type Gettable } from './client.js';

describe('unwrapEnvelope', () => {
  it('unwraps the response envelope and leaves bare bodies alone', () => {
    expect(unwrapEnvelope({ response: { total: 1 } })).toEqual({ total: 1 });
    expect(unwrapEnvelope([1, 2])).toEqual([1, 2]);
  });
});

describe('asList', () => {
  it('accepts a bare array', () => {
    expect(asList([1, 2]).items).toEqual([1, 2]);
  });

  it('finds the only array in an object, and keeps the reported total', () => {
    const list = asList({ response: { total: 7, users: [1, 2] } });
    expect(list.items).toEqual([1, 2]);
    expect(list.total).toBe(7);
    expect(list.key).toBe('users');
  });

  it('prefers the named key when a payload carries several arrays', () => {
    const list = asList({ response: { users: [1], nodes: [2, 3] } }, ['users']);
    expect(list.items).toEqual([1]);
  });

  it('refuses to guess between several arrays', () => {
    // Picking one silently is how an audit ends up counting the wrong entity
    // and reporting a confident, wrong number.
    expect(() => asList({ response: { users: [1], nodes: [2] } })).toThrow(/Ambiguous/);
  });

  it('says what it saw when there is no array at all', () => {
    expect(() => asList({ response: { total: 0 } })).toThrow(/Keys present: total/);
  });
});

describe('fetchAllPaged', () => {
  function pagingClient(pages: unknown[][], total: number | null): Gettable {
    return {
      get: vi.fn(async (_path, query) => {
        const start = Number(query?.start ?? 0);
        const size = Number(query?.size ?? pages[0]?.length ?? 0);
        const index = size === 0 ? 0 : start / size;
        return { response: { total, users: pages[index] ?? [] } };
      }),
    };
  }

  it('walks every page and stops on the reported total', async () => {
    const client = pagingClient([[1, 2], [3, 4], [5]], 5);
    const result = await fetchAllPaged(client, '/api/users', { pageSize: 2, preferredKeys: ['users'] });
    expect(result.items).toEqual([1, 2, 3, 4, 5]);
    expect(result.truncated).toBe(false);
  });

  it('stops on a short page even when no total is reported', async () => {
    const client = pagingClient([[1, 2], [3]], null);
    const result = await fetchAllPaged(client, '/api/users', { pageSize: 2, preferredKeys: ['users'] });
    expect(result.items).toEqual([1, 2, 3]);
  });

  it('reports truncation instead of looping when the endpoint ignores the offset', async () => {
    // An endpoint that hands back page one forever would otherwise spin until
    // memory ran out, and a partial sweep silently reported as complete is the
    // worst possible outcome for a migration audit.
    const stuck: Gettable = { get: async () => ({ response: { total: 100, users: [1, 2] } }) };
    const result = await fetchAllPaged(stuck, '/api/users', {
      pageSize: 2,
      preferredKeys: ['users'],
      hardCap: 10,
    });
    expect(result.truncated).toBe(true);
    expect(result.items.length).toBeGreaterThanOrEqual(10);
  });

  it('reports progress as it goes, so a 30 000-row sweep is not a silent wait', async () => {
    const seen: number[] = [];
    const client = pagingClient([[1, 2], [3, 4]], 4);
    await fetchAllPaged(client, '/api/users', {
      pageSize: 2,
      preferredKeys: ['users'],
      onPage: (loaded) => seen.push(loaded),
    });
    expect(seen).toEqual([2, 4]);
  });
});
