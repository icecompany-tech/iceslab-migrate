#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * Today it does one thing: `audit`, which reads a source panel and prints what
 * a migration would and would not carry. It writes nothing anywhere - not to
 * the source, not to a target - which is what makes it safe to hand to an
 * operator who has not decided to move yet.
 */

import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { auditInventory } from './analysis/audit.js';
import { renderReport } from './report/text.js';
import { RemnawaveAdapter } from './sources/remnawave/adapter.js';
import type { SourceAdapter } from './sources/types.js';

const USAGE = `
iceslab-migrate - move an existing panel's data into Iceslab

  iceslab-migrate audit --from <panel> --url <https://panel> [options]

Options
  --from <panel>       Source panel kind. Supported: remnawave
  --url <url>          Base URL of the source panel API
  --token <token>      API token. Prefer the SOURCE_TOKEN env var: an argument
                       lands in shell history and in the process list
  --out <file>         Write the report here as well as to stdout
  --json <file>        Write the machine-readable result here
  --page-size <n>      Rows per request when paging (default 500)
  --throttle-ms <n>    Pause between requests (default 0)
  --timeout-ms <n>     Per-request timeout (default 30000)
  --quiet              Progress off
  -h, --help

Exit codes
  0  audit completed, nothing blocks an import
  2  audit completed, blocking items found
  1  audit could not complete

The report names real subscribers in its examples. Treat the file as customer
data: it is not something to paste into a public issue.
`.trim();

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      url: { type: 'string' },
      token: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'string' },
      'page-size': { type: 'string' },
      'throttle-ms': { type: 'string' },
      'timeout-ms': { type: 'string' },
      quiet: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const command = positionals[0];
  if (command !== 'audit') {
    console.error(`Unknown command "${command}". Only "audit" exists so far.`);
    return 1;
  }

  const token = values.token ?? process.env.SOURCE_TOKEN;
  const url = values.url;
  const from = values.from ?? 'remnawave';

  if (!url) return fail('Missing --url.');
  if (!token) return fail('Missing token. Pass --token or set SOURCE_TOKEN.');

  const adapter = makeAdapter(from, {
    baseUrl: url,
    token,
    pageSize: toInt(values['page-size'], 500),
    throttleMs: toInt(values['throttle-ms'], 0),
    timeoutMs: toInt(values['timeout-ms'], 30_000),
  });
  if (!adapter) return fail(`Unknown source "${from}". Supported: remnawave.`);

  const progress = values.quiet ? () => {} : (msg: string) => console.error(msg);

  progress(`reading ${from} at ${url} (read-only)`);
  const inventory = await adapter.collect(progress);
  progress('analysing...');

  const result = auditInventory(inventory);
  const report = renderReport(result, new Date());

  console.log(report);

  if (values.out) {
    await writeFile(values.out, `${report}\n`, 'utf8');
    progress(`report written to ${values.out}`);
  }
  if (values.json) {
    await writeFile(values.json, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    progress(`json written to ${values.json}`);
  }

  return result.findings.some((f) => f.severity === 'blocker') ? 2 : 0;
}

function makeAdapter(
  kind: string,
  opts: { baseUrl: string; token: string; pageSize: number; throttleMs: number; timeoutMs: number },
): SourceAdapter | null {
  if (kind === 'remnawave') return new RemnawaveAdapter(opts);
  return null;
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function fail(message: string): number {
  console.error(message);
  console.error('');
  console.error(USAGE);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`\naudit failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
