# iceslab-migrate

Command-line tool for migrating an existing proxy panel into
[Iceslab](https://github.com/icecompany-tech/iceslab).

## Supported source panels

| Source | Status |
|---|---|
| `remnawave` | audit implemented |
| `3x-ui` | planned |

## Status

Only `audit` is implemented: it reads a source panel and reports what a
migration would carry, what it would carry with losses, and what it cannot carry
at all. The source is opened read-only, the client has exactly one verb (`get`),
and nothing is written to the source or to a target.

Import is not implemented yet.

## Requirements

- Node.js >= 22
- pnpm >= 10
- An API token for the source panel with read access

## Install

Not published to npm. Run from source:

```bash
git clone https://github.com/icecompany-tech/iceslab-migrate
cd iceslab-migrate
pnpm install
```

## Usage

```bash
iceslab-migrate audit --from <panel> --url <https://panel> [options]
```

Audit, report to stdout:

```bash
export SOURCE_TOKEN='<api token>'
pnpm dev audit --from remnawave --url https://panel.example.com
```

Write the text report and the machine-readable result:

```bash
pnpm dev audit \
  --from remnawave \
  --url https://panel.example.com \
  --out audit.txt \
  --json audit.json
```

Large or rate-limited source:

```bash
pnpm dev audit \
  --from remnawave \
  --url https://panel.example.com \
  --page-size 200 \
  --throttle-ms 250 \
  --timeout-ms 60000
```

Built binary instead of `pnpm dev`:

```bash
pnpm build
node dist/cli.js audit --from remnawave --url https://panel.example.com
```

## Options

| Flag | Env | Default | Description |
|---|---|---|---|
| `--from <panel>` | | `remnawave` | Source panel kind |
| `--url <url>` | | | Base URL of the source panel API. Required |
| `--token <token>` | `SOURCE_TOKEN` | | API token. Prefer the env var: an argument lands in shell history and in the process list |
| `--out <file>` | | | Write the text report here as well as to stdout |
| `--json <file>` | | | Write the machine-readable result here |
| `--page-size <n>` | | `500` | Rows per request while paging |
| `--throttle-ms <n>` | | `0` | Pause between requests |
| `--timeout-ms <n>` | | `30000` | Per-request timeout |
| `--quiet` | | `false` | Progress off |
| `-h`, `--help` | | | Usage |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Audit completed, nothing blocks an import |
| `2` | Audit completed, blocking items found |
| `1` | Audit could not complete |

## What it reads

All requests are `GET`.

| Endpoint | Used for |
|---|---|
| `/api/auth/status` | Brand name |
| `/api/users` | Users, paged |
| `/api/internal-squads` | Squads |
| `/api/hosts` | Hosts |
| `/api/config-profiles` | Config profiles and their inbounds |
| `/api/nodes` | Nodes |
| `/api/subscription-settings` | Subscription settings |
| HWID devices | Device inventory, paged |

Nodes, devices and subscription settings are optional. If the token cannot read
them the audit continues and records what it could not see, rather than failing.

## User fields read

| Field | Notes |
|---|---|
| `uuid`, `username`, `shortUuid` | Identity. `shortUuid` is the subscription token |
| `status` | Mapped to an Iceslab status; unmappable values are blockers |
| `trafficLimitBytes`, `trafficLimitStrategy` | Quota and reset strategy |
| `expireAt` | Expiry. A far-future date is reported as "means never" |
| `telegramId`, `email` | Not unique on the source; duplicates are reported |
| `description`, `tag` | Free text. Over-long values are reported as lossy |
| `hwidDeviceLimit` | Device cap |
| `vlessUuid`, `trojanPassword`, `ssPassword` | Credentials. An invalid VLESS UUID is a blocker |
| `subRevokedAt`, `lastTrafficResetAt`, `createdAt` | Timestamps |
| `activeInternalSquads` | Squad membership |
| `userTraffic.usedTrafficBytes`, `lifetimeUsedTrafficBytes` | Accumulated traffic |

Unknown fields are reported, not ignored: a field added by the source panel
since this adapter was written shows up as a finding instead of being dropped
silently.

## Findings

Every finding carries a severity and a code.

| Severity | Meaning |
|---|---|
| `blocker` | Stops the import |
| `manual` | Has to be rebuilt by hand |
| `lossy` | Moves, but loses something |
| `anomaly` | Looks wrong on the source |
| `note` | Worth knowing |

| Area | Codes |
|---|---|
| Users | `username-invalid`, `username-duplicate`, `sub-token-invalid`, `sub-token-duplicate`, `vless-uuid-invalid`, `status-unmappable`, `strategy-unmappable`, `text-too-long`, `expiry-means-never`, `traffic-limit-zero`, `traffic-limit-not-whole-gb`, `telegram-id-shared` |
| Hosts | `host-multi-address`, `host-sni-from-address`, `host-orphan-inbound`, `host-route-unrouted`, `host-without-route`, `host-disabled`, `host-settings-dropped`, `route-label-contradiction` |
| Inbounds | `reality-server-names-over-limit`, `inbound-not-stock`, `routing-not-converted`, `external-assets` |
| Devices | `device-metadata-dropped`, `device-orphan` |
| Settings | `subscription-settings-unread`, `subscription-settings-unsupported`, `client-detection-rules`, `source-fields-not-read` |

Routing rules, outbounds and DNS are reported under `manual`, not converted: the
source keeps a whole engine config per profile, and rebuilding that is a panel
feature rather than a migration step.

## Output

> [!WARNING]
> The report names real subscribers in its examples. Treat `--out` and `--json`
> files as customer data and keep them out of public issues.

`audit*.json`, `audit*.txt` and `report*` are git-ignored in this repository for
that reason.

## Development

```bash
pnpm test        # vitest, no network
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc -> dist/
```

The analysis is pure (inventory in, findings out), so every case is tested on
fixtures rather than against a live panel.

## License

AGPL-3.0-only.
