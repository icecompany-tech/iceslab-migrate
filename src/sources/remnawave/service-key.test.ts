import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { renameServiceKey, ServiceKeyError, SOURCE_SERVICE_KEY as K } from './service-key.js';

/** The shapes their Clash-family templates use: the key on top, in a group
 *  and in a provider, comments, anchors and a merge key. */
const MIHOMO = `${K}:
  includeHiddenHosts: false

x-anchors:
  pr_http: &pr_http
    type: http
    interval: 86400

mixed-port: 7890
proxy-providers:
  extra:
    <<: *pr_http
    url: https://example.com/p.yaml
    ${K}:
      include-proxies: true

proxy-groups:
  - name: VPN
    type: select
    proxies:
      - Fastest
      # LEAVE THIS LINE!
  - name: Fastest
    ${K}:
      include-proxies: true
    type: url-test
    proxies: # LEAVE THIS LINE!

proxies: # LEAVE THIS LINE!

rules:
  - MATCH,VPN
`;

const SINGBOX = `{
  "${K}": { "includeHiddenHosts": true },
  "outbounds": [ { "type": "direct", "tag": "direct" } ]
}
`;

/** Every map key anywhere in the text. */
function keysOf(text: string): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (isMap(n)) {
      for (const p of n.items) {
        if (isScalar(p.key)) out.push(String(p.key.value));
        walk(p.value);
      }
    } else if (isSeq(n)) n.items.forEach(walk);
  };
  walk(parseDocument(text).contents);
  return out;
}

describe('renameServiceKey', () => {
  it('renames the key at the top, in a group and in a provider, and leaves every other byte', () => {
    const r = renameServiceKey(MIHOMO);
    expect(r.renamed).toBe(3);
    expect(r.text).toBe(MIHOMO.split(`${K}:`).join('iceslab:'));
    expect(r.text).toContain('# LEAVE THIS LINE!');
    expect(r.text).toContain('<<: *pr_http');
    expect(keysOf(r.text)).not.toContain(K);
  });

  it('JSON: the quoted key keeps its quotes', () => {
    const r = renameServiceKey(SINGBOX);
    expect(r).toEqual({ text: SINGBOX.replace(`"${K}"`, '"iceslab"'), renamed: 1 });
    expect(JSON.parse(r.text)).toMatchObject({ iceslab: { includeHiddenHosts: true } });
  });

  it('a template without the key comes out unchanged', () => {
    const plain = 'proxies:\nrules:\n  - MATCH,DIRECT\n';
    expect(renameServiceKey(plain)).toEqual({ text: plain, renamed: 0 });
  });

  it('the key where Iceslab reads none is refused with its line', () => {
    const err = (() => {
      try {
        renameServiceKey(`proxies:\nrules:\n  - MATCH,DIRECT\ndns:\n  ${K}:\n    x: 1\n`);
      } catch (e) {
        return e;
      }
    })() as ServiceKeyError;
    expect(err).toBeInstanceOf(ServiceKeyError);
    expect(err.line).toBe(5);
  });

  it('a text that does not parse is said with its position', () => {
    expect(() => renameServiceKey('{ "outbounds": [ }')).toThrow(/not valid JSON/);
  });
});

/**
 * The public catalogue of templates written for the source panel, when a copy
 * is at hand (TEMPLATES_REF_DIR, the folder holding by-legiz/). Not vendored:
 * it carries no licence.
 */
const REF = process.env.TEMPLATES_REF_DIR;
const REF_DIR = REF ? join(REF, 'by-legiz', 'subscription-templates') : '';
const files = REF && existsSync(REF_DIR) ? readdirSync(REF_DIR).filter((f) => /\.(ya?ml|json)$/.test(f)) : [];

describe.skipIf(files.length === 0)('the catalogue templates (TEMPLATES_REF_DIR)', () => {
  for (const file of files) {
    it(`${file}: the key made ours, nothing of theirs left`, () => {
      const r = renameServiceKey(readFileSync(join(REF_DIR, file), 'utf8'));
      expect(keysOf(r.text)).not.toContain(K);
    });
  }
});
