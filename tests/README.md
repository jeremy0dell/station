# Testing

This guide owns Station's test layout, gate selection, and isolation policy.
`package.json`, `config/vitest/`, and the GitHub workflows remain the executable
sources of truth.

## Choose a gate

Run the narrowest relevant test while iterating. Build first when a test launches
compiled files from `dist`.

For documentation-only changes:

```sh
pnpm lint
pnpm test:diagnostics:policy
```

For an implementation change, finish with:

```sh
pnpm test:all
```

Station renderer changes also require the renderer/PTY lane before the repository
gate:

```sh
pnpm --dir station typecheck
pnpm --dir station test
pnpm test:ci:station
```

`test:all` is the deterministic repository gate. It builds, typechecks, lints,
runs unit, contract, integration, diagnostics, scripted-agent, setup E2E, and
Observer E2E coverage, then runs the installer smoke. Use the focused scripts in
`package.json` when only one responsibility needs to be repeated.

Codex hook reconciliation has a focused cross-system gate:

```sh
pnpm test:e2e:codex-hook-reconciliation
```

## Quick Session performance

The virtual-monotonic matrix is deterministic and runs in `test:all`:

```sh
pnpm benchmark:quick-session
```

The following opt-in lanes use installed Worktrunk, Git, Bun, or real Station
Host processes and write raw output beneath
`.dev-state/performance/quick-session/`:

```sh
pnpm benchmark:quick-session:real
pnpm benchmark:quick-session:worktrunk
pnpm benchmark:quick-session:native-git
pnpm benchmark:quick-session:pty
pnpm benchmark:quick-session:end-to-end
pnpm benchmark:quick-session:end-to-end-paired
```

The real Observer matrix uses 49-worktree repositories and covers warm/cold
singles, 3/5/20 bursts, and two projects in parallel. The paired end-to-end lane
counterbalances fake and real terminal boundaries against a healthy warmed Host,
and requires exact command, worktree, session, PTY, scan, inventory, and cleanup
outcomes.

See the [final report](performance/quick-session/report.md) for benchmark
boundaries and retained results, and the
[experiment ledger](performance/quick-session/ledger.md) for preregistered
hypotheses and mechanical keep/revert decisions. Generated artifacts and
one-off diagnostic runners are intentionally excluded from the review diff;
the complete redacted evidence set is preserved on the
[2026-08-25 evidence archive](https://github.com/jeremyodell/station/tree/archive/quick-session-performance-evidence-2026-08-25/tests/performance/quick-session).

The pre-push hook is intentionally lint-only. It does not replace `test:all` or
the focused gate required by the change.

## Test layout

- Workspace unit and integration tests live under `apps/*/test`,
  `packages/*/test`, or `integrations/*/*/test`.
- Station OpenTUI tests are colocated under `station/src` and run with Bun. Flexible
  layout coverage should exercise production components with mixed-height content,
  clipping-edge focus, resize, and pointer/keyboard convergence; deterministic
  operation counts are preferred to wall-clock assertions for scaling policy.
- Cross-system tests live under top-level `tests/`.
- Repeatable performance matrices live under `tests/performance/`; generated
  raw output belongs under `.dev-state/performance/`, not in ordinary PRs.
- `tests/support/` owns fake providers, fake tools, temporary projects,
  assertions, databases, and sockets.
- `tests/diagnostics/injected-failures/` owns deterministic evidence fixtures.
- `tests/agent/scripted/` and `tests/agent/scenarios/` are deterministic and
  eligible for standard CI.
- Real-agent tests live under `tests/agent/real/` and are always opt-in.
- `tests/e2e/real/` owns product-level real E2E coverage and is always opt-in.

Do not add floating tests outside the established workspace or top-level test
directories.

## Machine isolation

Vitest lanes that can touch machine state use the shared test-machine sandbox.
The sandbox gives each run private HOME, XDG, Station state, sockets, provider
homes, and fake tool paths. Keep these rules when adding a lane:

- Add central Vitest configurations to a package script and apply the shared
  sandbox unless the lane owns equivalent isolation or is explicitly real.
- Keep `GIT_*` environment values local to the test that needs them.
- Do not mutate `process.env` concurrently within one test process.
- Use `STATION_TEST_MACHINE_KEEP_ROOT=1` only to preserve a failed sandbox for
  inspection.
- Treat machine-isolation exceptions as deliberate policy with a reason in the
  policy test, not as undocumented omissions.

`config/vitest/` defines the current lane membership. The diagnostics policy
test proves that every central configuration is reachable from `package.json`
and is either automatically isolated or an explicit exception.

## Hosted CI

Ready, non-draft pull requests fan into independently reported lanes and finish
at the required `standard-ci` aggregate. Documentation-only changes run the
static and diagnostics policy path. Selected installer, binary, shell-matrix,
and stress lanes run only when classification requires them.

Draft pull requests allocate no runner. Pushes to `main` run only the inexpensive
post-merge build, typecheck, and lint checks. Exhaustive Observer claim stress is
scheduled in `nightly-observer-claim.yml`. Release tags run standard CI before
native release builds begin.

## Opt-in real lanes

Real lanes use installed tools, credentials, or terminal state and are excluded
from `test:all`:

- `pnpm test:e2e:worktrunk:real` uses a real Worktrunk installation.
- `STATION_REAL_TMUX=1 pnpm test:tmux-popup:real` uses an isolated tmux server.
- `pnpm test:e2e:claude:real`, `test:e2e:codex:real`, and
  `test:e2e:cursor:real` use authenticated agent CLIs.
- `pnpm test:e2e:pi:real` and `test:e2e:opencode:real` exercise those real
  harnesses.
- `pnpm test:e2e:real` runs the product real E2E lane with Worktrunk, tmux,
  Codex, a built `bin/stn`, and isolated provider homes.

Use [Local development](../docs/local-development.md) for checkout-isolated
runtime setup and [TUI development](../docs/tui.md) for native renderer and PTY
verification.
