/**
 * Render an audit as text a human reads once and acts on.
 *
 * Written for the operator, not for us: it opens with what would stop an
 * import, and ends with the table they need next to their old panel while they
 * rebuild the parts we do not carry. No colour codes - this gets pasted into
 * chat, saved to a file, and read over SSH.
 */

import type { AuditResult, Finding, Severity } from '../analysis/audit.js';

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: 'STOPS THE IMPORT',
  manual: 'REBUILD BY HAND',
  lossy: 'MOVES, BUT LOSES SOMETHING',
  anomaly: 'LOOKS WRONG ON THE SOURCE',
  note: 'WORTH KNOWING',
};

const SEVERITY_ORDER: Severity[] = ['blocker', 'manual', 'lossy', 'anomaly', 'note'];

export function renderReport(result: AuditResult, generatedAt: Date): string {
  const out: string[] = [];
  const { ref, counts } = result;

  out.push(rule('='));
  out.push(`iceslab-migrate audit - nothing was written to the source`);
  out.push(`source:    ${ref.kind} at ${ref.url}${ref.brand ? ` ("${ref.brand}")` : ''}`);
  out.push(`generated: ${generatedAt.toISOString()}`);
  out.push(rule('='));
  out.push('');

  // ───── Inventory ─────
  out.push(heading('What is on the source'));
  out.push(pair('users', String(counts.users)));
  for (const [status, count] of Object.entries(counts.usersByStatus).sort((a, b) => b[1] - a[1])) {
    out.push(pair(`  ${status.toLowerCase()}`, String(count)));
  }
  out.push(pair('users with traffic used', String(counts.usersWithTraffic)));
  out.push(pair('traffic used (sum)', formatBytes(counts.usedTrafficBytes)));
  out.push(pair('traffic lifetime (sum)', formatBytes(counts.lifetimeTrafficBytes)));
  out.push(pair('squads', String(counts.squads)));
  out.push(pair('squad memberships', String(counts.squadMemberships)));
  out.push(
    pair(
      'hosts',
      `${counts.hosts} (${counts.hostsEnabled} enabled)` +
        (counts.hostsAfterAddressExpansion !== counts.hosts
          ? ` -> ${counts.hostsAfterAddressExpansion} here, one per address`
          : ''),
    ),
  );
  out.push(pair('config profiles', `${counts.profiles} holding ${counts.inbounds} inbounds`));
  out.push(pair('devices', String(counts.devices)));
  out.push(pair('nodes', String(counts.nodes)));
  out.push('');

  // ───── Findings ─────
  const bySeverity = new Map<Severity, Finding[]>();
  for (const finding of result.findings) {
    const bucket = bySeverity.get(finding.severity) ?? [];
    bucket.push(finding);
    bySeverity.set(finding.severity, bucket);
  }

  for (const severity of SEVERITY_ORDER) {
    const group = bySeverity.get(severity);
    if (!group || group.length === 0) continue;
    out.push(heading(`${SEVERITY_LABEL[severity]} (${group.length})`));
    for (const finding of group) out.push(...renderFinding(finding));
    out.push('');
  }

  if (result.findings.filter((f) => f.severity === 'blocker').length === 0) {
    out.push('No blockers. Nothing found here would stop an import.');
    out.push('');
  }

  // ───── Route catalog ─────
  if (result.routeCatalog.length > 0) {
    out.push(heading('Route ids: what each one sells'));
    out.push(
      'The id is baked into the subscriber\'s UUID and decides where they come out. It has to',
    );
    out.push('survive the move unchanged, so check this table against what you actually sell.');
    out.push('');
    out.push(
      table(
        ['route', 'hosts', 'on', 'outbounds', 'sold as'],
        result.routeCatalog.map((row) => [
          String(row.routeId),
          String(row.hostCount),
          String(row.enabledHostCount),
          row.outbounds.join(', ') || '-',
          row.phrases.join(' / ') || '-',
        ]),
      ),
    );
    out.push('');
  }

  // ───── Topology ─────
  if (result.topology.length > 0) {
    out.push(heading('Hosts, and where each one leads'));
    out.push(
      table(
        ['host', 'on', 'addr', 'route', 'profile / inbound', 'outbounds', 'squads'],
        result.topology.map((row) => [
          truncate(row.remark, 34),
          row.enabled ? 'yes' : 'no',
          String(row.addresses.length),
          row.routeId === null ? '-' : String(row.routeId),
          row.profile ? `${row.profile} / ${row.inboundTag ?? '?'}` : '(orphan)',
          row.outbounds.join(', ') || '-',
          truncate(row.squads.join(', '), 30),
        ]),
      ),
    );
    out.push('');
  }

  // ───── Squad grants ─────
  if (result.squadGrants.length > 0) {
    out.push(heading('Squads: what each will be granted'));
    out.push('Their model denies hosts per host; ours grants them per squad. This is the inversion,');
    out.push('and a squad that sees everything gets no rows at all - that is our "all" default.');
    out.push('');
    out.push(
      table(
        ['squad', 'hosts granted', 'rows written'],
        result.squadGrants.map((grant) => [
          truncate(grant.squad, 32),
          String(grant.hostCount),
          grant.seesEverything ? 'none (sees all)' : String(grant.hostCount),
        ]),
      ),
    );
    out.push('');
  }

  out.push(rule('-'));
  out.push(summaryLine(result));
  out.push(rule('-'));

  return out.join('\n');
}

function renderFinding(finding: Finding): string[] {
  const lines: string[] = [];
  const count = finding.count !== undefined ? `  [${finding.count}]` : '';
  lines.push(`  * ${finding.title}${count}   (${finding.code})`);
  if (finding.detail) lines.push(...wrap(finding.detail, 4));
  if (finding.samples && finding.samples.length > 0) {
    lines.push(`    e.g. ${finding.samples.join(' | ')}`);
  }
  if (finding.action) {
    lines.push(...wrap(`-> ${finding.action}`, 4));
  }
  lines.push('');
  return lines;
}

function summaryLine(result: AuditResult): string {
  const counted = (severity: Severity) => result.findings.filter((f) => f.severity === severity).length;
  const blockers = counted('blocker');
  const verdict =
    blockers === 0
      ? 'Ready to rehearse an import.'
      : `Fix ${blockers} blocking item${blockers === 1 ? '' : 's'} first.`;
  return (
    `${verdict}  ` +
    `blockers ${blockers}, rebuild-by-hand ${counted('manual')}, lossy ${counted('lossy')}, ` +
    `anomalies ${counted('anomaly')}, notes ${counted('note')}.`
  );
}

// ───── Formatting helpers ─────

function heading(text: string): string {
  return `${text}\n${'-'.repeat(text.length)}`;
}

function rule(char: string): string {
  return char.repeat(78);
}

function pair(label: string, value: string): string {
  return `  ${label.padEnd(26, '.')} ${value}`;
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * Column width in terminal cells.
 *
 * Flags and emoji occupy two cells but more than one code unit, so plain
 * `.length` drifts and the table stops lining up exactly where the data is most
 * interesting (host labels are full of country flags).
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0x1f300 && code <= 0x1f9ff) ||
      (code >= 0x1f1e6 && code <= 0x1f1ff);
    width += wide ? 2 : 1;
  }
  return width;
}

function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[i] ?? ''))),
  );
  const line = (cells: string[]) =>
    '  ' + cells.map((cell, i) => padTo(cell, widths[i] ?? 0)).join('  ').trimEnd();

  return [
    line(headers),
    '  ' + widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map((row) => line(row)),
  ].join('\n');
}

function wrap(text: string, indent: number): string[] {
  const width = 78 - indent;
  const pad = ' '.repeat(indent);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(pad + current);
      current = word;
    }
  }
  if (current !== '') lines.push(pad + current);
  return lines;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}
