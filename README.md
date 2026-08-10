# iceslab-migrate

Move an existing proxy panel's data into [Iceslab](https://github.com/icecompany-tech/iceslab)
with one command.

Right now it does the first half of that: **`audit`**, which reads a source panel
and tells you exactly what a migration would carry, what it would carry with
losses, and what it cannot carry at all. It writes nothing, anywhere.

## Why not just export and import

Because a switch-over is not an import into an empty panel. The people you are
moving are already paying, already connected, and already have a link saved in
their client. That means:

- **accumulated traffic has to come across.** A subscriber on a monthly quota
  who wakes up with a fresh counter got a free month; one whose counter is wrong
  the other way writes to support.
- **credentials have to come across.** Regenerate them and every subscriber has
  to re-import their config by hand, on the same day.
- **the route a host selects has to come across unchanged.** If a route id means
  "Switzerland, no ads" on the source, it has to mean that here. Getting this
  wrong is invisible to every check except the subscriber's own eyes.
- **it has to be repeatable.** The source keeps living between the rehearsal and
  the real thing, so the last run is a delta, not a fresh load.

An audit first, because the answer to "can we move on Tuesday" is a list of
things that would break, not an opinion.

## Usage

```bash
# token via env, so it stays out of shell history and the process list
export SOURCE_TOKEN='...'

npx iceslab-migrate audit --from remnawave --url https://panel.example
```

Useful flags:

```
--out report.txt      also write the report to a file
--json report.json    machine-readable result, same content
--page-size 500       rows per request while paging
--throttle-ms 200     pause between requests; the source is production
--quiet               no progress output
```

Exit codes: `0` nothing blocks an import, `2` blocking items found, `1` the
audit could not complete.

## What the report contains

1. **Inventory** - how many of each thing, and in what state.
2. **What would stop an import** - usernames our schema rejects, duplicate
   subscription tokens, statuses with no equivalent, masquerade lists longer
   than we allow. Fix these first; they are the difference between a migration
   and a half-migration.
3. **What has to be rebuilt by hand** - routing rules, outbounds and DNS. The
   source keeps a whole engine config per profile and its whole product lives in
   there. Converting that is a panel feature, not a migration step, and
   pretending otherwise would deliver neither. The audit prints it instead.
4. **What moves but loses something** - per-host settings we do not model,
   device metadata, over-long text.
5. **What looks wrong on the source** - the same product label sitting on two
   different routes, one Telegram id across many accounts, hosts pointing at
   nothing. A migration is the first time in years anything reads every row;
   these get printed, never silently "fixed".
6. **The route table and the host table** - what each route id sells and where
   each host leads, for rebuilding the parts we do not carry.

The report names real subscribers in its examples. Treat the file as customer
data.

## Safety

- **The source is opened read-only.** The client has exactly one verb, `get`.
  There is no write path to remove, disable or forget to guard.
- **Unknown fields are reported, not ignored.** The source is someone else's
  product on their release schedule; a field that appeared since this adapter
  was written shows up as a line in the report rather than as data quietly left
  behind.
- **Ambiguity fails loudly.** If a response holds three arrays and none of them
  is named what we expect, the tool says what it saw instead of picking one.

## Sources

| Source | Status |
|---|---|
| `remnawave` | audit implemented |
| `3x-ui` | planned |

Naming the source panels outright is deliberate here, and scoped to this
repository: a migration tool that will not say what it migrates *from* is
useless to the person looking for it.

## Development

```bash
pnpm install
pnpm test        # unit tests, no network
pnpm typecheck
pnpm dev audit --from remnawave --url https://panel.example
```

The analysis is pure - inventory in, findings out - so every interesting case
(a contradictory route label, a range expression read the wrong way) is tested
on fixtures rather than discovered against a live panel at 3am.

## License

AGPL-3.0-only, same as Iceslab.
