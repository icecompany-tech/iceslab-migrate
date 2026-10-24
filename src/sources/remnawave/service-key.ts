/**
 * The source panel's service key inside a subscription template, made ours.
 *
 * Both panels fill a template the same way; the key a template uses to tell
 * the builder how to fill it is named after the panel. Iceslab reads `iceslab`
 * at the top of the frame, in a Clash-family proxy group and in a proxy
 * provider (apps/panel-backend/src/modules/subscription-templates/
 * templates.parse.ts). So the source's key is renamed in exactly those places,
 * in the TEXT, by the node's own range: the operator's comments, anchors and
 * layout come out as they went in, and a JSON key keeps its quotes. A source
 * key anywhere else has no counterpart in Iceslab and is refused with its
 * line, never carried silently.
 *
 * What the renamed key SAYS is not judged here: the panel checks it on import
 * and refuses, with its line, what it does not read.
 */

import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLMap } from 'yaml';

export const SOURCE_SERVICE_KEY = 'remnawave';
export const ICESLAB_SERVICE_KEY = 'iceslab';

export class ServiceKeyError extends Error {
  constructor(
    message: string,
    readonly line?: number,
    readonly column?: number,
  ) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'ServiceKeyError';
  }
}

/** The text with the source key renamed, and how many were. */
export function renameServiceKey(text: string): { text: string; renamed: number } {
  const json = /^\s*[[{]/.test(text);
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: true });
  if (doc.errors.length > 0) {
    const e = doc.errors[0]!;
    const pos = e.linePos?.[0];
    throw new ServiceKeyError(`not valid ${json ? 'JSON' : 'YAML'}: ${e.message.split('\n')[0]}`, pos?.line, pos?.col);
  }
  const root = doc.contents;
  if (!isMap(root)) throw new ServiceKeyError('the template is not a config object at the top');

  // Where Iceslab reads a service key.
  const owners: YAMLMap[] = [root];
  if (!json) {
    const groups = root.get('proxy-groups', true);
    if (isSeq(groups)) for (const g of groups.items) if (isMap(g)) owners.push(g);
    const providers = root.get('proxy-providers', true);
    if (isMap(providers)) for (const p of providers.items) if (isMap(p.value)) owners.push(p.value);
  }

  const ranges: [number, number][] = [];
  for (const owner of owners) {
    for (const pair of owner.items) {
      if (isScalar(pair.key) && pair.key.value === SOURCE_SERVICE_KEY && pair.key.range) {
        ranges.push([pair.key.range[0], pair.key.range[1]]);
      }
    }
  }
  const taken = new Set(ranges.map(([s]) => s));
  const stray = findKey(root, (n) => isScalar(n) && n.value === SOURCE_SERVICE_KEY && !taken.has(n.range?.[0] ?? -1));
  if (stray) {
    const at = lines.linePos(stray.range?.[0] ?? 0);
    throw new ServiceKeyError(
      'the service key stands where Iceslab reads none (only at the top, in a proxy group or in a proxy provider)',
      at.line,
      at.col,
    );
  }

  let out = text;
  for (const [start, end] of [...ranges].sort((a, b) => b[0] - a[0])) {
    const quote = /^["']/.exec(out.slice(start, end))?.[0] ?? '';
    out = out.slice(0, start) + quote + ICESLAB_SERVICE_KEY + quote + out.slice(end);
  }
  return { text: out, renamed: ranges.length };
}

/** The first map KEY anywhere under `node` that `match` accepts. */
function findKey(node: unknown, match: (n: Node) => boolean): Node | null {
  if (isMap(node)) {
    for (const p of node.items) {
      if (p.key && match(p.key as Node)) return p.key as Node;
      const inner = findKey(p.value, match);
      if (inner) return inner;
    }
  } else if (isSeq(node)) {
    for (const i of node.items) {
      const inner = findKey(i, match);
      if (inner) return inner;
    }
  }
  return null;
}
