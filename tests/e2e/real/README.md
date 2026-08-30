# Real E2E

This suite runs `bin/stn` and `bin/stn-ingress` against real config TOML, a real observer process, a real Unix socket, real SQLite state, real Worktrunk, real tmux, and real Codex or Claude. Every Codex-launching scenario uses one shared fixture with an isolated temporary `CODEX_HOME`; its Station wrapper propagates that home into the Observer and its Codex wrapper enables hook trust bypass only for the temporary project. The Codex and Claude hook fixtures install their generated artifacts against an attempt-scoped `stn-ingress` witness, retaining raw input, invocation time, argv, exit status, stdout, and stderr for recovery diagnostics.

It is intentionally excluded from `bun run test:e2e` and `bun run test:all`.

## Prerequisites

The native mouse scenario additionally requires Bun 1.4.0, the root workspace's Station
dependencies, Python 3, and tmux. It drives a real authenticated Codex launch.

```bash
bun install
bun run build
bun run setup:system:check
python3 --version
tmux -V
codex login status
```

Run with explicit flags:

```bash
STATION_REAL_E2E=1 \
STATION_REAL_WORKTRUNK=1 \
STATION_REAL_CODEX=1 \
STATION_WORKTRUNK_BIN="$(command -v wt)" \
STATION_TMUX_BIN="$(command -v tmux)" \
STATION_CODEX_BIN="$(command -v codex)" \
bun run test:e2e:real
```

For local real E2E from this repository, use the wrapper scripts instead of inline shell variables:

```bash
bun run test:e2e:real:local
bun run test:e2e:real:codex-hooks
bun run test:e2e:real:codex-hooks:keep-temp
```

The first-class Session and Group CLI pilot is a separately confirmed paid lane. It fetches,
clones, installs, and builds exact `origin/main`; then one Codex/Luna-xhigh agent reads the
preliminary Station CLI skill and performs the bounded P1 discovery cell against a private
Observer, Worktrunk clone, config, Codex home, and tmux server. The runner closes the exact
session at completion or after five minutes and prints separate application, agent, model, and
session-close evidence. The outer runtime owner then proves process-group and private tmux cleanup
before printing cleanup success. Claude is intentionally skipped and remains a TODO while no
subscription is available:

```bash
bun run test:e2e:cli-ux:pilot -- --yes
```

The provider-neutral recovery acceptance is `real-native-session-recovery.test.ts`. Its Codex case
runs in the normal local lane. Claude is separately opt-in because it requires a configured Claude
account:

```bash
bun run test:e2e:real:local tests/e2e/real/real-native-session-recovery.test.ts
STATION_REAL_CLAUDE=1 bun run test:e2e:real:local tests/e2e/real/real-native-session-recovery.test.ts
```

For each provider, the test completes one interactive sentinel turn, proves matching raw hook,
admitted observation, Station session, durable execution, exact recovery handle, and eligible
Observer assessment before destroying the named private tmux session. It then verifies the dormant
`agent-resume` action, dispatches `session.resumeAgent`, and requires a post-resume `SessionStart`
with the same provider-native and Station identities before completing a follow-up sentinel.

The popup navigation test is part of the local real E2E lane. It creates a real Worktrunk worktree, starts a real Codex agent in the tmux workbench, opens the station TUI in a real tmux popup over that agent pane, injects a numeric activation key through the popup TTY, and verifies tmux lands back on the same primary agent pane after the popup exits.

`real-tui-control.test.ts` uses the real scripted harness process rather than Codex. It retains the process's dead tmux pane, Groups the retained Station session, activates the row through the real TUI, confirms **Start fresh**, and verifies exactly one replacement launch under the same session and Group with one workbench window. It then removes that terminal entirely and proves `session.close({ mode: "all" })` remains durable across an Observer restart.

`real-native-tui-mouse.test.ts` obtains its dormant Codex row through that shared recovery proof,
then runs bare `stn` with tmux context removed; tmux is only the
fixed-size PTY and capture envelope. The test sends raw SGR bytes through an attached client
(no `tmux send-keys` and no OpenTUI `mockMouse`), then proves native renderer selection, hover,
exactly-once collapse/expand clicks, and a visible row activation that launches real Codex and
changes the Observer snapshot. Run it alone with:

```bash
bun run test:e2e:real:local tests/e2e/real/real-native-tui-mouse.test.ts
```

## Isolation

Each generated config owns a separate short `0700` tmux endpoint root outside its temporary repository clone. Its wrapper adds only `-f /dev/null`; the config and fixture helpers select the private socket. Tests also use a temporary station config, Worktrunk config, observer socket, SQLite state directory, hook witness directory, and local clone. Codex scenarios additionally own a private `CODEX_HOME`, Claude owns its injected settings artifact, and the native mouse test owns its attached PTY client and native Station process.

The active checkout is never passed to Worktrunk as the project root. Cleanup kills only the explicit private tmux server, proves that endpoint unreachable, and then removes its root (including retained socket pathnames); uncertain endpoint failures retain the root for diagnosis. Observer, Worktrunk, and clone cleanup remain independent. Product cleanup treats an already-absent terminal as retired while preserving unrelated provider failures; the scripted stale-pane scenario exercises both stale replacement and terminal-absent session close.

Set `STATION_REAL_E2E_KEEP_TEMP=1` while debugging a failure to leave the observer, tmux session, Worktrunk state, and temp clone in place. Clean those resources manually after inspection.

## Failure Triage

On lifecycle failures, tests attempt to write `stn debug bundle` under the test state directory. Start with:

- `provider-health.json`
- `commands.jsonl`
- `events.jsonl`
- `errors.jsonl`
- `logs/observer.jsonl`
- `diagnostic-index.json`

Real Codex can be slow or model-dependent. The prompts are bounded and target only sentinel files under `.station-real-e2e/sentinels/` in the temp clone.

The Codex hook lane retains its private profile, canonical hook script, and Observer diagnostics in the test temp root. Use those with `events.jsonl` to confirm that Codex lifecycle hooks such as `SessionStart`, tool-use events, compaction events, subagent events, and `Stop` came from the real Codex process and were ingested as `harness.eventReported` events for provider `codex`.

Pi has a separate opt-in launch-scaffolding lane at `tests/agent/real/pi`. Run it with `bun run test:e2e:pi:real` and `STATION_REAL_PI=1` when validating the Pi tmux launch path before adding full real Pi callback assertions.
