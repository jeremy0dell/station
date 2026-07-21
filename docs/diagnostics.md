# station Diagnostics

This document describes the current local diagnostic surface for observer runs, provider health, command records, debug bundles, redaction, retention, and derived evidence indexes.

## Commands

Existing-state lookup:

```bash
stn debug trace <id>
stn debug trace --latest-failure
stn debug logs [query]
stn debug logs [query] --component hook
```

Live observer checks:

```bash
stn observer status
stn doctor [--project <projectId>] [--deep]
stn snapshot --json [--include-debug]
stn observe --include-snapshot --duration 3s
stn observe --json --include-snapshot --duration 3s
stn observe --json --failed --limit 20
stn observe --json --trace <traceId>
stn observe --json --command <commandId>
stn command get <commandId>
```

Evidence capture:

```bash
stn debug bundle
stn debug bundle --trace <traceId>
stn debug bundle --command <commandId>
stn debug bundle --latest-failure
stn debug bundle --last 30m
stn debug bundle --since <isoTimestamp>
```

Setup and hook checks:

```bash
stn setup check --json
stn setup system --check
pnpm setup:system:check
stn hooks doctor worktrunk
stn hooks doctor claude
stn hooks doctor codex
stn hooks doctor cursor
stn hooks doctor opencode
stn event-hooks doctor
```

`stn debug trace` reads existing diagnostic bundles and structured logs to
correlate trace ids, command ids, diagnostic ids, root-cause codes, redacted
command diagnostics, and suggested next commands without contacting the observer.
When a command error envelope includes external-command diagnostics, trace output
can show the command, cwd, exit code, duration, and bounded stdout/stderr
snippets after redaction.

`stn debug logs` reads structured JSONL logs from the configured state
directory without contacting the observer. By default it searches `observer`,
`cli`, and `tui` logs, excludes noisy hook logs, returns recent `warn`/`error`
records when no query is supplied, and searches all levels when a query is
supplied. Use `--component hook` or `--all-components` only when hook delivery
or provider-ingress noise is relevant.

`stn observer status` checks the configured observer process/socket state. It is
non-mutating, but it is still a live status check rather than an existing-state
log read.

`stn doctor` connects to the observer, asks the observer for runtime health, and reports config, SQLite, provider health, hook spool, snapshot, logs, local state usage, and retention status. If the config cannot be loaded, `doctor` does not start the observer; it returns a local SafeError report with diagnostic id `config-load`.

`stn snapshot --json` asks the observer for the current normalized graph. Use
`--include-debug` when row-level diagnostic fields are needed for support
evidence.

`stn observe` streams the observer's current snapshot and live events. Use
`--json` for JSONL envelopes, `--pane` for an alternate-screen terminal tail,
`--failed` for failure-focused streams, `--trace` / `--command` for correlation
filters, and bounded flags such as `--duration 3s` for smoke checks.

`stn command get <commandId>` asks the observer for a command lifecycle record.
Failed provider commands may include optional redacted diagnostics derived from
the persisted command error envelope. The command record keeps live SafeError
events lean while still making provider command failures self-diagnosing from
the command/debug surfaces. `stn command dispatch --stdin` intentionally
submits a command; use it only when the task calls for a runtime action.

`stn debug bundle` asks the observer for a diagnostic snapshot, then writes a redacted bundle under the configured state directory. If the config cannot be loaded, it writes a local invalid-config bundle next to the failing config instead of contacting the observer.

`stn setup check --json`, `stn setup system --check`, and
`pnpm setup:system:check` report local tool readiness. They are read-only.

Provider hooks are diagnosed as delivery hints, not runtime truth. `stn-ingress` assigns stable event ids, tries bounded delivery to the observer, attempts bounded observer auto-start when enabled, and writes a spool record only when startup or delivery fails. Harness reports are accepted into an observer-owned ingress queue before slower persistence, projection, and reconcile work. Queue depth, coalescing, drop/failure counts, and last spool-drain stats appear in observer health and diagnostic snapshots. Hook delivery decisions are written to `logs/hooks.jsonl`; hook payload attributes are redacted before they appear in logs or debug bundles.

When `defaults.worktree_provider = "worktrunk"`, doctor also validates Worktrunk
binary availability, lifecycle hook setup, and automation capability for the
configured lifecycle-hook mode. Missing `wt` degrades provider health with
`WORKTRUNK_UNAVAILABLE`, the attempted command, any resolved path, version output
when available, and an install hint. Worktrunk lifecycle hooks are not mandatory
for every install: `worktree.worktrunk.use_lifecycle_hooks = false` makes
automated mutations pass `--no-hooks`, `true` makes them pass `--yes`, and unset
uses Worktrunk's default prompt behavior. Doctor and setup report the effective
mode and validate that the installed `wt` supports the required flag for the
configured mode. Missing or untrusted hooks degrade the report when hooks are
expected; explicitly disabled hooks are reported as the skip-hooks automation
mode instead. Provider command failures from `wt` are recorded through provider
health, command records, logs, debug traces, and debug bundle evidence.

A checkout-style configured root with local `core.bare=true` is reported as
`WORKTRUNK_PROJECT_ROOT_BARE`. `stn project doctor <projectId>` reports the
configuration-side warning, while `stn doctor --project <projectId>` reports the
scoped Worktrunk project check and degraded project health. Worktrunk list,
create, and remove operations are blocked before `wt` runs. Station does not
repair Git config automatically; use the reported commands to inspect the
setting and either set local `core.bare=false` for the intended checkout or
correct `projects.root`.

Doctor also reports Worktrunk registrations whose working directories are
missing or prunable. `stn doctor --project <id>` limits this scan to one project;
the unscoped command scans configured projects with bounded concurrency and
reports if its time budget permits only partial coverage. Inspect the exact
prune operation before changing Git metadata, then run it without `--dry-run`:

```bash
git -C '<project-root>' worktree prune --dry-run --verbose
git -C '<project-root>' worktree prune --verbose
```

Pruning removes administrative records for worktree directories that are
already gone; it does not delete a live worktree directory.

## Manual Smoke

After building, the diagnostic surface can be checked with a throwaway fake-provider config:

```bash
tmpdir="$(mktemp -d /tmp/station-smoke-XXXXXX)"
mkdir -p "$tmpdir/state" "$tmpdir/run"

cat > "$tmpdir/config.toml" <<EOF
schema_version = 1
projects = []

[observer]
socket_path = "$tmpdir/run/observer.sock"
state_dir = "$tmpdir/state"

[defaults]
worktree_provider = "fake-worktree"
terminal = "fake-terminal"
harness = "fake-harness"
layout = "agent-shell"
EOF

node apps/cli/dist/main.js --config "$tmpdir/config.toml" doctor
node apps/cli/dist/main.js --config "$tmpdir/config.toml" debug bundle
node apps/cli/dist/main.js --config "$tmpdir/config.toml" observer stop
```

This starts the lazy observer, verifies doctor output, writes a debug bundle under `$tmpdir/state/diagnostics`, and stops the observer. It uses fake providers only and should not touch real project state. If a sandbox blocks Unix socket binding, run the smoke outside that sandbox.

## Local State

Default paths live under the observer state directory:

```text
observer.sqlite
logs/observer.jsonl
logs/cli.jsonl
logs/tui.jsonl
logs/hooks.jsonl
diagnostics/
spool/hooks/
```

SQLite remains observer-owned runtime history. CLI and TUI use protocol APIs and do not read SQLite as runtime truth. JSONL logs and debug bundles are diagnostic evidence only.

## Bundle Sections

The operational bundle includes:

```text
manifest.json
config-summary.json
observer-health.json
snapshot.json
provider-health.json
diagnostic-index.json
commands.jsonl
events.jsonl
errors.jsonl
logs/observer.jsonl
spool-summary.json
local-state.json
retention.json
redaction-report.json
README.txt
```

Command records, events, logs, and error envelopes carry `commandId`, `traceId`,
and `spanId` where available. Failed command records can also carry optional
redacted diagnostics such as external command, cwd, exit code, duration, and
bounded stdout/stderr snippets.

`diagnostic-index.json` is derived evidence, not runtime truth. It correlates config diagnostics, SQLite health, provider health, command failures, events, error envelopes, hook spool state, logs, and row/session facts into:

- root cause codes such as `INVALID_CONFIG`, `MISSING_WORKTRUNK_BINARY`, `WORKTRUNK_UNSUPPORTED_FLAG`, `WORKTRUNK_HOOK_APPROVAL_REQUIRED`, `WORKTRUNK_BASE_MISSING`, `STALE_TERMINAL_TARGET`, `HOOK_SPOOL_FALLBACK`, `PROVIDER_TIMEOUT`, `HARNESS_UNEXPECTED_EXIT`, and `SQLITE_WRITE_FAILURE`
- evidence items with provider, command, trace, diagnostic, row, target, and run identifiers when available
- row-level provider questions so common debugging can be answered from CLI JSON and bundle files without a TUI inspect panel

The deterministic diagnosis oracle fixtures live under `tests/agent/scenarios/diagnosis/`. They validate evidence-index classification without invoking a real agent.

## Retention Defaults

Default diagnostic retention is bounded and visible through `stn doctor`:

```toml
[observability.retention]
max_days = 14
max_total_mb = 250
max_file_mb = 10
max_files_per_component = 5

[observability.retention.debug_bundles]
max_bundles = 10
max_days = 30
```

File retention is enforced for logs and bundles created by this diagnostic surface. SQLite over-limit status is reported, but SQLite rows are not pruned by this retention pass.

## Redaction

SafeError output excludes stacks and raw provider payloads. Error envelopes,
command diagnostics, debug traces, and debug bundles may include internal
details only after redaction. Secret-like keys, authorization headers,
token-looking values, and command output snippets are redacted before being
written to logs, command records, trace output, or bundles.

## Worktrunk Hook Setup

Worktrunk hooks are explicit and reversible:

```bash
station --config /path/to/config.toml worktrunk hooks plan
station --config /path/to/config.toml worktrunk hooks install --yes
station --config /path/to/config.toml worktrunk hooks doctor
station --config /path/to/config.toml worktrunk hooks uninstall --yes
```

Generated hook bodies call `stn-ingress --socket <observer.sock> --state-dir <state> --spool-dir <state>/spool/hooks --config /path/to/config.toml worktrunk <event>` by default. They do not contain lifecycle logic. The installer backs up the Worktrunk config, preserves unrelated hook commands, and removes only generated STATION entries on uninstall.

Generic aliases are also available for the Worktrunk hook setup surface:

```bash
station --config /path/to/config.toml hooks plan worktrunk
station --config /path/to/config.toml hooks doctor worktrunk
station --config /path/to/config.toml hooks install worktrunk --yes
station --config /path/to/config.toml hooks uninstall worktrunk --yes
```

Other provider and event hook setup surfaces use the same reversible pattern:

```bash
station --config /path/to/config.toml hooks plan claude
station --config /path/to/config.toml hooks doctor claude
station --config /path/to/config.toml hooks install claude --yes
station --config /path/to/config.toml hooks uninstall claude --yes

station --config /path/to/config.toml hooks plan codex
station --config /path/to/config.toml hooks doctor codex
station --config /path/to/config.toml hooks install codex --yes
station --config /path/to/config.toml hooks uninstall codex --yes

station --config /path/to/config.toml hooks plan cursor
station --config /path/to/config.toml hooks doctor cursor
station --config /path/to/config.toml hooks install cursor --yes
station --config /path/to/config.toml hooks uninstall cursor --yes

station --config /path/to/config.toml hooks plan opencode
station --config /path/to/config.toml hooks doctor opencode
station --config /path/to/config.toml hooks install opencode --yes
station --config /path/to/config.toml hooks uninstall opencode --yes

station --config /path/to/config.toml event-hooks doctor
```

Hook `plan` and `doctor` commands are diagnostic/planning surfaces. Hook
`install` and `uninstall` mutate external tool configuration and require
explicit `--yes`.

Real Worktrunk E2E coverage is opt-in:

```bash
STATION_REAL_WORKTRUNK=1 STATION_WORKTRUNK_BIN="$(command -v wt)" pnpm test:e2e:worktrunk:real
```

Default test commands skip this lane because it requires a local external `wt` binary and isolated Worktrunk state.
