/**
 * Subscription templates, read from the source and handed back as files.
 *
 * The operator who moves brings their templates along. The insertion contract
 * of these templates is Iceslab's too; only the service key differs, and the
 * panel renames it on import (POST /api/subscription-templates/import, or the
 * Import file button on the Templates screen), checking what it says. So this
 * step does not rewrite anything: it writes each template as the source holds
 * it, under a name that carries the Iceslab type, and the panel does the rest
 * with the same code an operator's own upload goes through.
 *
 * Read-only like the rest of the tool: two GETs per run plus one per template.
 */

import { asList, unwrapEnvelope, type Gettable } from './client.js';

/** Iceslab's template types (packages/shared/src/transport-support.ts,
 *  TEMPLATE_TYPES). Mirrored, like src/target/iceslab.ts. */
export type IceslabTemplateType = 'mihomo' | 'stash' | 'clash' | 'singbox' | 'xray-json' | 'xray-json-array';

/**
 * Source type -> ours. Their XRAY_JSON is one config per host with the
 * template around each, which is our `xray-json-array`; XRAY_BASE64 is a list
 * of links and has no template by nature.
 */
export const TEMPLATE_TYPE_MAP: Record<string, IceslabTemplateType | null> = {
  MIHOMO: 'mihomo',
  STASH: 'stash',
  CLASH: 'clash',
  SINGBOX: 'singbox',
  XRAY_JSON: 'xray-json-array',
  XRAY_BASE64: null,
};

export interface SourceTemplate {
  name: string;
  sourceType: string;
  /** Null: a type Iceslab frames no file for (said in the report). */
  type: IceslabTemplateType | null;
  /** The template text as the source holds it; null when it had none. */
  text: string | null;
  /** The file it goes to, when it goes anywhere. */
  file: string | null;
}

/** A file name the operator can read: the type first, then the template's own
 *  name, anything a file system dislikes as a dash. */
export function templateFileName(type: IceslabTemplateType, name: string): string {
  const safe = name.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'template';
  return `${type}--${safe}.${type === 'mihomo' || type === 'stash' || type === 'clash' ? 'yaml' : 'json'}`;
}

function textOf(t: Record<string, unknown>): string | null {
  if (typeof t.encodedTemplateYaml === 'string' && t.encodedTemplateYaml !== '') {
    return Buffer.from(t.encodedTemplateYaml, 'base64').toString('utf8');
  }
  if (t.templateJson !== null && t.templateJson !== undefined) return `${JSON.stringify(t.templateJson, null, 2)}\n`;
  return null;
}

export async function collectTemplates(client: Gettable): Promise<SourceTemplate[]> {
  const list = asList(await client.get('/api/subscription-templates'), ['templates']);
  const out: SourceTemplate[] = [];
  const taken = new Set<string>();
  for (const raw of list.items) {
    const head = raw as Record<string, unknown>;
    const uuid = typeof head.uuid === 'string' ? head.uuid : null;
    // The list is documented as "without content" on some versions: the
    // template is read on its own when the list did not carry it.
    // A type we frame nothing for is not fetched at all.
    const wanted = (TEMPLATE_TYPE_MAP[String(head.templateType ?? '')] ?? null) !== null;
    const fetched = wanted && textOf(head) === null && uuid
      ? (unwrapEnvelope(await client.get(`/api/subscription-templates/${uuid}`)) as Record<string, unknown> | null)
      : null;
    const full = fetched && typeof fetched === 'object' ? fetched : head;
    const sourceType = String(full.templateType ?? head.templateType ?? '');
    const name = String(full.name ?? head.name ?? '');
    const type = TEMPLATE_TYPE_MAP[sourceType] ?? null;
    const text = textOf(full);
    let file: string | null = null;
    if (type && text !== null) {
      file = templateFileName(type, name);
      // Two names that clean to one file stay two files.
      for (let i = 2; taken.has(file); i++) file = templateFileName(type, `${name}-${i}`);
      taken.add(file);
    }
    out.push({ name, sourceType, type, text, file });
  }
  return out;
}
