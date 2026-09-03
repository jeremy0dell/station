# Station Diagnostics

This is the reference for Station's diagnostic commands, health semantics,
evidence bundles, redaction, and retention behavior. For symptom-first recovery,
start with [Debugging](debugging.md).

## Choose a diagnostic surface

| Need | Command | Effect |
| --- | --- | --- |
| Correlate a trace, command, or diagnostic ID | `stn debug trace <id>` | Reads retained bundles and logs without contacting Observer. |
| Find the latest retained failure | `stn debug trace --latest-failure` | Reads retained bundles and logs without contacting Observer. |
| Search component logs | `stn debug logs [query]` | Reads local JSONL logs without contacting Observer. |
| Check the configured process and socket | `stn observer status` | Inspects live status without starting Observer. |
| Check current runtime health | `stn doctor [--project <id>]` | May start Observer if it is absent. |
| Read the current normalized graph | `stn snapshot --json [--include-debug]` | May start Observer if it is absent. |
| Read the graph without starting Observer | `stn snapshot --json --require-running` | Fails if Observer is not already running. |
| Stream current state and events | `stn observe --json --include-snapshot --duration 3s` | Contacts or starts Observer and reads live events. |
| Inspect one command lifecycle | `stn command get <commandId>` | Contacts or starts Observer. |
| Capture shareable evidence | `stn debug bundle --trace <traceId>` | Contacts or starts Observer and writes a redacted bundle. |
| Check setup or hook readiness | `stn setup check --json`, `stn hooks doctor <provider>`, `stn event-hooks doctor` | Inspects local setup and provider files without applying changes. |

Use each command's `--help` or `--man` output for its complete current option
set. Useful bundle filters include `--command <commandId>`,
`--latest-failure`, `--last 30m`, and `--since <isoTimestamp>`.

`stn setup check --json` does not change configuration, provider homes, sockets,
or durable Observer state. Its state-directory readiness check may create and
remove a temporary probe file and can leave a new empty state directory; see
[System dependencies](system-dependencies.md). Provider and event-hook doctor
commands are read-only. Hook install, uninstall, and reconcile commands mutate
external configuration, while command dispatch and project operations can
change runtime state.

## Correlate and interpret evidence

`stn debug trace` correlates trace, command, and diagnostic IDs across retained
bundles and structured logs. When available, it reports redacted external-command
facts such as the command, working directory, exit code, duration, bounded
stdout/stderr, and the effective `PATH` for a missing executable.

A matching warning, error, or outer error code proves that the recorded failure
occurred; it does not by itself prove the underlying cause. JSON trace and log
output separates explicit root-cause evidence from observed failure evidence in
`causeAssessment`. Its `evidenceRoles` and `componentRole` fields also distinguish
failure ownership from the component that happened to log the event.

Without a query, `stn debug logs` searches recent warning and error records from
the Observer, CLI, TUI, and Station Host logs. A query searches all levels. Add
`--component hook` only when provider delivery is relevant, or use
`--all-components` for every component.

Exact `STATION_CLI_TRACE=1` enables best-effort CLI process start and outcome
records. These records can carry route shape, bounded process facts, and
top-level trace or command IDs. They exclude argument values, stdin, command
output, config paths, working directories, environment values, prompts,
arbitrary error messages and causes, and resource payloads. Tracing never gates
effects or changes command output or exit status.

## Current health semantics

`stn doctor` reports current config, SQLite, provider, hook-spool, snapshot,
local-state, and retention checks. Its top-level status is determined only by
the current checks:

| Current checks | Top-level status |
| --- | --- |
| At least one `error` | `unavailable` |
| No errors and at least one `warn` | `degraded` |
| All checks are `ok` | `healthy` |

`recentErrors` is historical evidence and does not change current health by
itself. A healthy report can therefore contain retained errors. Invalid config
is a current error: Doctor returns an `unavailable` local report with diagnostic
ID `config-load` and does not start Observer.

The `observer-singleton` check reports the cached startup inspection. A warning
points to `stn observer reap`, but Doctor never signals a process or acquires the
startup claim. Follow [Observer singleton lifecycle](observer-singleton.md)
before acting on duplicate-process evidence.

`stn snapshot --json` returns the current normalized graph.
`--include-debug` adds the latest reconciled terminal evidence; it is not fresh
mutation authority. `stn observe` streams the current snapshot and live events,
and `stn command get` returns one recorded command lifecycle. Failed command
records can reference redacted diagnostic evidence without copying provider
payloads into ordinary live error events.

## Provider and hook health

Hook health proves installation and delivery readiness, not current runtime
state. Confirm current truth through Doctor, snapshots, and reconcile evidence.
See [Harness ingress](harness-ingress.md) for admission, correlation, spooling,
and artifact ownership; see [Harness authoring](harness-authoring.md) for the
provider integration contract.

When Worktrunk is active, Doctor reports executable availability, lifecycle-hook
expectations, and the configured automation mode. A checkout-style project root
with local `core.bare=true` is reported as `WORKTRUNK_PROJECT_ROOT_BARE` and
Worktrunk list, create, and remove operations are blocked before `wt` runs.
Station does not rewrite Git configuration; follow the report's remediation to
fix the intended checkout or correct `projects.root`.

Doctor can also report registrations whose worktree directories are already
missing. Inspect the exact Git metadata change before applying it:

```bash
git -C '<project-root>' worktree prune --dry-run --verbose
git -C '<project-root>' worktree prune --verbose
```

The second command removes stale administrative records; it does not delete a
live worktree directory. Run it only after the dry run confirms the target.
Provider installation and repair procedures belong to
[System dependencies](system-dependencies.md).

## Local evidence and bundles

The configured Observer state directory contains:

```text
observer.sqlite
logs/{observer,cli,tui,station-host,hooks}.jsonl
diagnostics/
spool/hooks/
```

SQLite is Observer-owned runtime history. Logs and bundles are diagnostic
evidence, not a second source of current runtime truth.

`stn debug bundle` collects a diagnostic snapshot and writes a redacted bundle
under `diagnostics/`. If config cannot load, it writes a local invalid-config
bundle next to the failing config without contacting Observer. An operational
bundle contains:

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

Records carry command, trace, and span IDs where available.
`diagnostic-index.json` is derived evidence: it correlates config, provider,
command, event, error, spool, log, and row facts, but it is not runtime truth.

## Retention guarantees

The default top-level and bundle limits are:

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

[Configuration](configuration.md)
owns the complete field reference. Doctor and debug bundles report the resolved
policy and local usage. Exceeding the total local-state limit produces a current
retention warning and degrades Doctor.

These settings do not universally rotate or prune JSONL logs, debug bundles, or
command/error SQLite rows. Provider-observation expiry and hook-spool cleanup
apply their owner-specific retention rules. SQLite age settings do not remove
retained command errors from `recentErrors` or independently determine Doctor's
top-level status.

## Redaction guarantees

SafeError output excludes stacks and raw provider payloads. Lifecycle reports
and boot tails are redacted before crossing the process boundary. Error
envelopes, command diagnostics, traces, logs, and bundles redact secret-like
keys, authorization headers, token-looking values, and captured command output
before persistence or display.

Redaction reduces exposure but does not make a bundle public: it can still
contain internal paths, project identifiers, provider names, and bounded command
evidence. Review a bundle before sharing it.
