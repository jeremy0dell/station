# Debugging

Status: current living entrypoint for runtime diagnosis and recovery.

For a runtime trace ID, command ID, diagnostic ID, or production symptom, start
with Station's evidence surfaces before reading source. Use the evidence to
identify the owning subsystem, then follow that subsystem's guide.

## First move

Use the narrowest surface that answers the question:

| Question | Start here |
| --- | --- |
| Known trace, command, or diagnostic ID | `stn debug trace <id>` |
| Latest known failure | `stn debug trace --latest-failure` |
| No ID yet; historical or local symptom | `stn debug logs [query]` |
| Current Observer process/socket state | `stn observer status` |
| Current runtime health | `stn doctor` |
| Current normalized graph | `stn snapshot --json` |
| Current graph with terminal evidence | `stn snapshot --json --include-debug` |
| Live state and events | `stn observe --json --include-snapshot --duration 3s` |
| One command lifecycle | `stn command get <commandId>` |
| Shareable redacted evidence | `stn debug bundle --trace <traceId>` |
| Setup or provider readiness | `stn setup check --json` or `stn hooks doctor <provider>` |

`stn debug trace`, `stn debug logs`, and existing bundles read retained
evidence without contacting the Observer. `doctor`, `snapshot`, `observe`,
`command get`, and `debug bundle` use the current Observer and may start it;
`debug bundle` also writes a redacted bundle. Reconcile, command dispatch,
project mutations, hook installation, and setup apply are mutating operations.

Use [Diagnostics](diagnostics.md) for command semantics, bundle contents,
redaction, retention, and hook-diagnosis details. Use [Testing](../tests/README.md)
for opt-in real-provider and performance lanes.

## Interpret failures

For a failed provider command, inspect the correlated evidence before the
provider implementation:

```bash
stn debug trace <traceOrCommandId>
stn command get <commandId>
```

Trace and command output may include redacted external-command diagnostics such
as the command, working directory, exit code, duration, bounded output, and the
effective `PATH` for a missing executable. A generic outer error or matching log
record establishes a failure, not necessarily its deeper cause.

For Worktrunk lifecycle failures, compare the configured automation mode with
the installed tool:

```bash
stn setup check --json
stn doctor
```

If provider artifacts are owned by another Station launcher, inspect the
reported current and requested owners. `--yes` confirms an ordinary mutation;
it does not transfer ownership. Use the explicit takeover flow only when
replacing that owner is intentional. See [Diagnostics](diagnostics.md) for the
reversible hook commands.

## Terminal reconcile evidence

Use `stn snapshot --json --include-debug` when the question is what terminal
evidence the latest reconcile committed. Under `debug.terminal`:

- `reconciledAt` identifies the represented reconcile generation.
- `providerReads` records each provider as `complete` or `indeterminate`; an
  indeterminate read includes its failure code.
- `targets` contains sanitized targets only from complete provider reads.
- `hasManagedAttachment` is tri-state evidence about what a provider could
  attach at observation time; it is not activation or mutation authority.

An indeterminate provider read excludes that provider's targets from both the
normalized graph and the debug envelope. Activation must resolve any managed
attachment again from current authority.

## Observer and state ownership

[Observer singleton lifecycle](observer-singleton.md) is authoritative for
process/socket ownership, the startup claim, pidfile identity, stale-evidence
repair, build-aware handoff, duplicate discovery, and explicit reap. Do not
delete a claim database, infer liveness from a pidfile, unlink an inaccessible
socket, or signal a process from a receipt or stale path alone.

Runtime state is under the configured Observer state directory. Use the CLI and
diagnostic surfaces to inspect it; SQLite, JSONL logs, bundles, and pane dumps
are evidence, not a second source of runtime truth. When ownership evidence is
ambiguous, preserve the state and choose an isolated socket/state directory
rather than attempting cleanup.

## Station runtime

Station adds a `station-station-host` process that can own PTYs beyond the life
of a renderer. A Host attachment being unavailable is not evidence that its
PTY or agent exited.

When the native workspace does nothing or a pane appears exited, inspect the
three lifecycle logs and current ownership before source:

```bash
stn debug logs --component tui
stn debug logs --component station-host
stn debug logs --component cli
stn host status
```

For an isolated checkout, use `bun run station:devbox status`. Follow
[TUI development](tui.md) for renderer, PTY, and terminal behavior. A busy
incompatible Host reports `HOST_UPGRADE_BLOCKED`; use the exact build named by
the evidence and account for live terminals before replacement. Never kill a
non-exact Host or remove its socket based only on display version, expected
command evidence, or a handoff receipt.

For same-TTY ownership errors, close the incumbent with `Ctrl-Q` and retry. If
that is impossible, independently inspect the candidate process before any
manual signal. Native TUI ownership is cooperative and fail-closed; the claim
file itself is not a stale lock.

The Host can retain an orphaned bridge under
`<state_dir>/run/pty-bridges/`. Use `stn host status` and the Host log to
distinguish an adoptable parked PTY from a completed exit. Do not remove a
retained park or signal its PID without revalidating the exact process, socket,
and PTY identity.

## Preserve live sessions before changing runtime state

When a blocked Observer or Host handoff threatens live agent work, create and
verify a private preservation archive before stopping, resuming, replacing, or
unlinking anything:

```bash
bun run station:sessions:save -- --devbox
bun run station:sessions:save -- --config ~/.config/station/config.toml
bun run station:sessions:verify -- ~/.local/state/station-session-rescues/<timestamp>
```

The save operation does not change Station, provider sessions, or worktrees.
Archives can contain terminal output, provider state, configuration, and
untracked files; treat them as sensitive data. A `partial` archive is evidence,
not permission to proceed. Continue only after verification is `"ok": true`
and every active session has provider-native recovery data.

Migration is a separate, deliberately downtime-producing operation. Plan first:

```bash
bun run station:sessions:migrate -- \
  --archive ~/.local/state/station-session-rescues/<timestamp> \
  --target-config ~/.config/station/config.toml \
  --source-devbox-root ~/Developer/station
```

The plan is read-only and binds source/target identities, recovery handles,
titles, provider-file conflicts, and target occupancy into a digest. Apply only
with that digest:

```bash
bun run station:sessions:migrate -- \
  --archive ~/.local/state/station-session-rescues/<timestamp> \
  --target-config ~/.config/station/config.toml \
  --source-devbox-root ~/Developer/station \
  --yes --expect-plan <digest-from-plan>
```

Apply closes only planned source sessions, never runs source and target agents
concurrently, never edits target TOML, and verifies canonical titles,
provider-native identity, and Host PTYs after resume. If interrupted, rerun with
the same digest: before source sealing, source remains authoritative; after
source sealing, the sealed archive is authoritative. Conflicting nonempty
provider databases are refused rather than merged.

## Reading evidence

Use [Diagnostics](diagnostics.md) for the local-state layout, bundle sections,
redaction rules, and retention behavior. The most useful current sources are:

- `stn debug trace <id>` for correlated retained evidence;
- `stn debug logs [query]` for bounded historical JSONL records;
- `stn doctor`, `stn snapshot --json`, and `stn observe --json` for current
  Observer truth;
- `stn host status` and `logs/station-host.jsonl` for Host ownership and
  attachment state; and
- the exact run's manifest and failure files for hosted binary-smoke evidence.

Do not run a trace against unrelated live state and do not treat old logs,
bundles, hook delivery, or provider receipts as current graph truth. Reconcile
from current configuration, provider state, and Observer health.

## Harness event investigation

For an unclear harness event mapping, follow [Harness signals](harness-signals.md)
and [Harness authoring](harness-authoring.md). Compare one captured provider
sequence with `stn debug logs "Harness event report"` and the provider's native
session log. Captured sequences belong in deterministic mapper fixtures; live
timing is not a substitute for that coverage.

For a stalled Observer subscriber, use the opt-in transport probe described in
[Testing](../tests/README.md#opt-in-real-lanes). It is a performance diagnostic,
not a normal runtime recovery step; keep its output outside the live state
directory and inspect the complete evidence bundle rather than RSS alone.

## Update convergence

`stn update --dry-run --json` is the read-only starting point. It reports the
v5 aggregate and plan, including exact Observer/Host evidence and parked-bridge
viability. Same-artifact apply runs hook, exact Observer, Host, parked-bridge,
persisted-state, and final-inspection capabilities in process. Artifact-changing
apply installs once and crosses once into the target launcher through a bounded
strict successor request; the target performs runtime convergence in process.
Unknown ownership and busy non-preservable terminals fail closed as
`reap-required`; `--no-handoff` is `intentionally-incomplete`. `current` and
`updated` require a completed final aggregate whose plan is `converged`.

## Detailed references

- [Diagnostics](diagnostics.md) — commands, bundles, redaction, retention, and hooks.
- [Observer singleton lifecycle](observer-singleton.md) — Observer ownership and reap.
- [TUI development](tui.md) — renderer, Host, PTY, and terminal contracts.
- [Single-binary Station](single-binary.md) — compiled runtime boundaries and assets.
- [Install Station](install.md) — install, update, and first-run recovery.
- [System dependencies](system-dependencies.md) — setup and external tool readiness.
