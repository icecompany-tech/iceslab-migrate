import { describe, expect, it, vi } from 'vitest';
import type { Gettable } from './client.js';
import { collectTemplates, templateFileName } from './templates.js';
import { SOURCE_SERVICE_KEY } from './service-key.js';

const yaml = 'proxies: # LEAVE THIS LINE!\n';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

function source(list: unknown[], byUuid: Record<string, unknown> = {}): Gettable {
  return {
    get: vi.fn(async (path: string) => {
      if (path === '/api/subscription-templates') return { response: { total: list.length, templates: list } };
      const uuid = path.split('/').pop()!;
      return { response: byUuid[uuid] };
    }),
  };
}

describe('collectTemplates', () => {
  it('maps their types onto ours, YAML out of base64 and JSON out of the object', async () => {
    const t = await collectTemplates(
      source([
        { uuid: 'a', name: 'ru bundle', templateType: 'MIHOMO', encodedTemplateYaml: b64(yaml), templateJson: null },
        { uuid: 'b', name: 'Default', templateType: 'XRAY_JSON', encodedTemplateYaml: null, templateJson: { outbounds: [] } },
        { uuid: 'c', name: 'links', templateType: 'XRAY_BASE64', encodedTemplateYaml: null, templateJson: null },
      ]),
    );
    expect(t.map((x) => [x.type, x.file])).toEqual([
      ['mihomo', 'mihomo--ru-bundle.yaml'],
      ['xray-json-array', 'xray-json-array--Default.json'],
      [null, null],
    ]);
    expect(t[0]!.text).toBe(yaml);
    expect(JSON.parse(t[1]!.text!)).toEqual({ outbounds: [] });
  });

  it('reads a template on its own when the list came without content', async () => {
    const client = source(
      [{ uuid: 'u1', name: 'stash', templateType: 'STASH', encodedTemplateYaml: null, templateJson: null }],
      { u1: { uuid: 'u1', name: 'stash', templateType: 'STASH', encodedTemplateYaml: b64(yaml), templateJson: null } },
    );
    const [t] = await collectTemplates(client);
    expect(t).toMatchObject({ type: 'stash', text: yaml, file: 'stash--stash.yaml' });
    expect(client.get).toHaveBeenCalledWith('/api/subscription-templates/u1');
  });

  it('writes the service key as Iceslab\'s, and a key it cannot place is said, not written', async () => {
    const t = await collectTemplates(
      source([
        { uuid: 'a', name: 'ok', templateType: 'MIHOMO', encodedTemplateYaml: b64(`${SOURCE_SERVICE_KEY}:\n  includeHiddenHosts: false\nproxies:\n`) },
        { uuid: 'b', name: 'odd', templateType: 'MIHOMO', encodedTemplateYaml: b64(`proxies:\ndns:\n  ${SOURCE_SERVICE_KEY}: {}\n`) },
      ]),
    );
    expect(t[0]).toMatchObject({ text: 'iceslab:\n  includeHiddenHosts: false\nproxies:\n', renamed: 1, file: 'mihomo--ok.yaml' });
    expect(t[1]).toMatchObject({ text: null, file: null });
    expect(t[1]!.refusal).toMatch(/^line 3:/);
  });

  it('two names that clean to one file stay two files', async () => {
    const t = await collectTemplates(
      source([
        { uuid: 'a', name: 'a/b', templateType: 'SINGBOX', templateJson: {} },
        { uuid: 'b', name: 'a b', templateType: 'SINGBOX', templateJson: {} },
      ]),
    );
    expect(t.map((x) => x.file)).toEqual(['singbox--a-b.json', 'singbox--a-b-2.json']);
  });

  it('keeps letters of any script in the file name', () => {
    expect(templateFileName('mihomo', 'Россия: всё')).toBe('mihomo--Россия-всё.yaml');
  });
});
