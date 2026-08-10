/**
 * Read-only HTTP client for the source panel.
 *
 * Two rules this file exists to enforce:
 *
 *  1. **No writes.** Only `get` is implemented. An operator is still selling
 *     from the source panel while we rehearse the move, so the tool must be
 *     incapable of touching it, not merely polite about it.
 *  2. **Loud failure over clever guessing.** Response envelopes differ between
 *     source versions. Where the shape is ambiguous we say what we saw instead
 *     of picking a field and hoping - a migration that silently reads the wrong
 *     array produces a report that looks fine and is wrong.
 */

export interface ClientOptions {
  baseUrl: string;
  token: string;
  /** Per-request timeout. The source is someone else's production box. */
  timeoutMs?: number;
  /** Pause between requests. Their rate limits are undocumented and a delta run
   *  will be hitting this regularly, so default to being a polite guest. */
  throttleMs?: number;
}

export class SourceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`GET ${path} -> HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = 'SourceHttpError';
  }
}

export class ReadOnlyClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly throttleMs: number;
  private lastRequestAt = 0;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.throttleMs = opts.throttleMs ?? 0;
  }

  /** The only verb. See the file header. */
  async get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    if (this.throttleMs > 0) {
      const wait = this.lastRequestAt + this.throttleMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    this.lastRequestAt = Date.now();

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        // Some panels sit behind a WAF that answers plain fetches with a
        // challenge page; a named agent makes our traffic identifiable in
        // the operator's logs when they ask "what is hitting my panel".
        'User-Agent': 'iceslab-migrate (read-only audit)',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    if (!res.ok) throw new SourceHttpError(res.status, path, text);

    try {
      return JSON.parse(text) as unknown;
    } catch {
      // An HTML body here almost always means "you reached the SPA, not the
      // API" - wrong base URL, or the panel serves its UI on the same host.
      const looksLikeHtml = text.trimStart().startsWith('<');
      throw new Error(
        looksLikeHtml
          ? `GET ${path} returned HTML, not JSON. Is --url pointing at the panel's API host?`
          : `GET ${path} returned a body that is not JSON: ${text.slice(0, 120)}`,
      );
    }
  }
}

/** Strip the `{ response: ... }` envelope when there is one. */
export function unwrapEnvelope(json: unknown): unknown {
  if (json && typeof json === 'object' && 'response' in json) {
    return (json as { response: unknown }).response;
  }
  return json;
}

export interface ListPayload {
  items: unknown[];
  /** Total as the source reports it, when it reports one. */
  total: number | null;
  /** Which property the array came from, for diagnostics. */
  key: string | null;
}

/**
 * Pull the list out of a response without guessing.
 *
 * Accepts: a bare array; an object holding exactly one array; an object holding
 * an array under one of `preferredKeys`. Anything else throws with the keys we
 * actually saw, because "which of these three arrays did you mean" is a
 * question the operator can answer in a second and this code cannot.
 */
export function asList(json: unknown, preferredKeys: string[] = []): ListPayload {
  const body = unwrapEnvelope(json);

  if (Array.isArray(body)) return { items: body, total: null, key: null };

  if (!body || typeof body !== 'object') {
    throw new Error(`Expected a list or an object holding one, got ${typeof body}`);
  }

  const record = body as Record<string, unknown>;
  const total = typeof record.total === 'number' ? record.total : null;

  for (const key of preferredKeys) {
    const value = record[key];
    if (Array.isArray(value)) return { items: value, total, key };
  }

  const arrayKeys = Object.keys(record).filter((k) => Array.isArray(record[k]));
  if (arrayKeys.length === 1) {
    const key = arrayKeys[0]!;
    return { items: record[key] as unknown[], total, key };
  }

  throw new Error(
    arrayKeys.length === 0
      ? `No array in response. Keys present: ${Object.keys(record).join(', ') || '(none)'}`
      : `Ambiguous response: several arrays present (${arrayKeys.join(', ')}). ` +
        `Name the right one in preferredKeys.`,
  );
}

/**
 * Page through an offset-paginated endpoint.
 *
 * Stops on the first of: the source's own `total` reached, a short page, or an
 * empty page. The `hardCap` is not a limit on the data - it is a guard against
 * an endpoint that ignores `start` and would otherwise loop forever handing
 * back page one. Hitting it is reported, never silently truncated.
 */
/** Just enough of the client to page with. Structural on purpose: the paging
 *  loop is worth testing without standing up an HTTP server. */
export interface Gettable {
  get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown>;
}

export async function fetchAllPaged(
  client: Gettable,
  path: string,
  opts: {
    pageSize: number;
    preferredKeys?: string[];
    hardCap?: number;
    onPage?: (loaded: number, total: number | null) => void;
  },
): Promise<{ items: unknown[]; total: number | null; truncated: boolean; listKey: string | null }> {
  const pageSize = opts.pageSize;
  const hardCap = opts.hardCap ?? 500_000;
  const items: unknown[] = [];
  let total: number | null = null;
  let listKey: string | null = null;
  let start = 0;

  for (;;) {
    const page = asList(await client.get(path, { start, size: pageSize }), opts.preferredKeys ?? []);
    if (total === null) total = page.total;
    if (listKey === null) listKey = page.key;

    items.push(...page.items);
    opts.onPage?.(items.length, total);

    if (page.items.length === 0) break;
    if (page.items.length < pageSize) break;
    if (total !== null && items.length >= total) break;
    if (items.length >= hardCap) {
      return { items, total, truncated: true, listKey };
    }
    start += pageSize;
  }

  return { items, total, truncated: false, listKey };
}
