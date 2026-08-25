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

`test:all` is the deterministic repository gate. It builds, typechecks, lints,
runs unit, contract, integration, diagnostics, scripted-agent, setup E2E, and
Observer E2E coverage, then runs the installer smoke. Use the focused scripts in
`package.json` when only one responsibility needs to be repeated.

Codex hook reconciliation has a focused cross-system gate:

```sh
pnpm test:e2e:codex-hook-reconciliation
```

Quick Session latency has a deterministic, machine-isolated benchmark:

```sh
pnpm benchmark:quick-session
```

It records monotonic stage timestamps and distribution summaries for warm and
cold singles, bursts, multi-project work, unrelated event contention, failure,
cancellation/recovery, and removal contention. Synthetic timings are a stable
orchestration regression gate, not a substitute for the opt-in real-provider
measurements recorded in its experiment ledger.

The opt-in real Observer lane runs the retained Quick Session command, launch,
projection, focus, and verification path against 49-worktree repositories:

```sh
pnpm benchmark:quick-session:real
```

It records warm/cold singles, 3/5/20 bursts, multi-project concurrency, raw
command and trace IDs, stage distributions, provider scans and classified
subprocess timings, CPU/process evidence, and post-reconcile canonical
convergence. Terminal and harness boundaries stay instrumented fakes so the
measurement isolates the real Worktrunk adapter (including its native-Git
hooks-disabled create path) plus Observer orchestration. Worktrunk must be
installed; this lane stays outside `test:all`.

The separate provider companion compares serialized and parallel Worktrunk
create bursts in fresh temporary Git repositories:

```sh
pnpm benchmark:quick-session:worktrunk
```

It runs 3/5/20 bursts both with lifecycle hooks disabled and with isolated
Station-style hook recorders enabled, verifies exact Git worktree and hook
inventory, records raw command and wall time, and removes only its own temporary
roots. Worktrunk must be installed; this lane stays outside `test:all`.

The paired provider diagnostic compares bounded-four Worktrunk and native Git
creation on fresh 49-worktree repositories in alternating order:

```sh
pnpm benchmark:quick-session:native-git
```

It runs five repetitions of 3/5/20 bursts, verifies exact branch/path inventory
and cleanup after each implementation, and records raw command, wall-clock,
resource, and load evidence. It deliberately covers only explicitly
hooks-disabled automation and stays outside `test:all`.

The bare-probe companion compares the retained per-create Git safety check with
an in-flight-only singleflight check:

```sh
pnpm benchmark:quick-session:native-git-bare-singleflight
```

It alternates 1/3/5/20 native-create bursts on five fresh 49-worktree
repositories at bound four. Concurrent callers may share only a currently
pending `core.bare` result; a deterministic settled-eviction check proves that a
later caller executes a new probe. Both paths retain process-backed path/branch
verification, administrative registration identity, exact inventory, cleanup,
redaction, and root-removal gates. This diagnostic stays outside `test:all` and
does not change production safety checks.

The lower-bound companion tests whether the retained native path benefits from
less simultaneous Git repository pressure:

```sh
pnpm benchmark:quick-session:native-git-bound-three
```

It alternates bounds four and three for 3/5/20 bursts on five fresh 49-worktree
repositories. Every command retains its own bare probe, native add,
process-backed path/branch verification, and administrative registration proof;
only admission differs. Exact peak concurrency, inventories, cleanup,
redaction, and root removal are mandatory. This diagnostic stays outside
`test:all` and does not change the production coordinator.

The removal counterpart compares the current Worktrunk list/remove workflow
with strict native Git revalidation and removal:

```sh
pnpm benchmark:quick-session:native-git-remove
```

It alternates 1/3/5/20 removal bursts on five fresh 49-worktree repositories at
bound four. Both paths revalidate exact path, branch, and Git administrative
identity before mutation; every run must remove only the selected non-primary
targets and their unique branches, return to 49 registrations, disable hooks,
redact temporary paths, and remove its root.

The native-Git pressure diagnostic compares bounds of four and eight in the
same fresh 49-worktree repository, alternating candidate order:

```sh
pnpm benchmark:quick-session:native-git-concurrency
```

It runs five repetitions of 3/5/20 bursts, checks exact unique branch/path
registration, peak concurrency, inventory, cleanup, and temporary-root removal,
and records paired timing, resource, and load evidence. It does not alter
Station's production admission bound and stays outside `test:all`.

The adaptive-overflow mode retains bound four for bursts through five, and for
larger bursts permits at most three active adds after the initial four-wide
wave's first completion:

```sh
pnpm benchmark:quick-session:native-git-adaptive-overflow
```

It uses the same alternating 3/5/20 matrix and 49-worktree shape, while also
proving the four-to-three transition. The original four-versus-eight command
and artifact defaults remain unchanged; neither mode alters production
admission.

The read-only inventory diagnostic compares Worktrunk's enriched list with
native Git porcelain on five fresh 49-worktree repositories:

```sh
pnpm benchmark:quick-session:native-git-list
```

It alternates command order, includes attached, detached, locked, and prunable
registrations, validates exact normalized structural inventories, records paired
timing/load/resource evidence, and removes its temporary roots. Native Git does
not claim Worktrunk's dirty or ahead/behind enrichment; this diagnostic stays
outside `test:all` and does not change production discovery.

The paired startup-read diagnostic combines each discovery strategy with the
same retained native-Git create and verification path:

```sh
pnpm benchmark:quick-session:startup-read-paired
```

It runs alternating enriched/structural pairs for cold and warm singles plus
3/5/20 bursts on five fresh 49-worktree repositories. Each strategy starts and
ends at the exact same inventory, uses bounded-four creation, records nearby
load/resource evidence, and removes its temporary root. The lane stays outside
`test:all` and changes no production discovery policy.

The deferred-enrichment variant uses the same fixture and thresholds, but lets
the candidate complete enriched preparation before warm work while cold timing
contains only structural readiness:

```sh
pnpm benchmark:quick-session:startup-enrichment-hybrid
```

The deferred-discovery variant times launch-bound native creation before the
startup Worktrunk read, then requires that read to observe the exact created
inventory before cleanup:

```sh
pnpm benchmark:quick-session:startup-discovery-deferred
```

Only the interactive interval excludes discovery; the read, strict parsing,
inventory proof, and cleanup remain mandatory. This is diagnostic evidence for
a possible Observer readiness experiment, not a production readiness change.

The pooled-worktree diagnostic compares retained native creation with activating
clean, detached, pre-created registrations:

```sh
pnpm benchmark:quick-session:pooled-worktree
```

It keeps 20 pool slots beside the ordinary 49-worktree shape, alternates native
create and pooled activation for singles and 3/5/20 bursts, records pool-fill
cost separately, and proves exact reset/branch cleanup after every strategy. It
is a provider-boundary experiment only; Station does not own a production pool.

The right-sized pool diagnostic repeats that comparison with only five slots:

```sh
pnpm benchmark:quick-session:pooled-worktree-five-slot
```

Singles and 3/5 bursts use pooled activation; burst-20 activates exactly five
slots and falls back to retained native creation for the remaining 15. It
records fifth-session completion separately from final completion and proves the
hybrid inventory, slot reset, fallback removal, branch cleanup, and return to
exactly 54 registrations. The original 20-slot command and behavior remain
unchanged.

The phased five-slot variant tests whether mixed Git pressure caused the hybrid
burst tail:

```sh
pnpm benchmark:quick-session:pooled-worktree-five-slot-phased
```

For overflow bursts it settles all five activations before admitting any native
fallback, and records the activation-complete/fallback-start barrier. All other
paired strategies, thresholds, repository shape, and safety checks match the
five-slot diagnostic.

The native-verification diagnostic compares retained process-backed post-create
verification with a strict read-only proof from Git's linked-worktree files:

```sh
pnpm benchmark:quick-session:native-git-verification
```

It alternates both strategies for singles and 3/5/20 bursts on five fresh
49-worktree repositories. Exact realpaths, branch refs, administrative
backlinks, stable registration metadata, inventories, bounded concurrency,
cleanup, and temporary-root removal are mandatory. The diagnostic stays outside
`test:all` and changes no production provider behavior.

The real PTY-readiness diagnostic drives both source bridge and compiled-style
Bun PTYs through Station Host's socket, immutable attachment identity, and
controller capability:

```sh
pnpm benchmark:quick-session:pty
```

It runs cold/warm singles and 3/5/20 bursts on five isolated Hosts per PTY
implementation. A child-ready marker is necessary but insufficient: timing ends
only after the attached controller writes a unique token and that exact child
acknowledges it. The lane records daemon health, spawn, attach, ready, input,
acknowledgement, inventory, shutdown, and cleanup evidence. It stays outside
`test:all` and changes no production launch or harness behavior.

The Host-prewarm diagnostic alternates on-demand Host startup with ensure
running concurrently beside the ordinary 49-worktree startup read:

```sh
pnpm benchmark:quick-session:host-prewarm
```

Timing starts at Quick Session intent after the same exact Worktrunk inventory
is available, and ends only after a real Bun PTY emits readiness and acknowledges
controller input. It separately gates startup-scan regression so prewarming
cannot claim a win by delaying Observer readiness. Compatible health, immutable
identity, inventories, shutdown, stderr, and all temporary roots remain
mandatory. The lane stays outside `test:all` and changes no production Host
lifecycle.

The compiled companion uses the current installed `__station-host` boundary,
including fresh packaged-helper preparation, in the same Worktrunk overlap
matrix:

```sh
pnpm benchmark:quick-session:host-prewarm-compiled
```

It builds the binary outside timing and additionally requires at least four of
five prewarmed Hosts to be healthy before immediate post-scan intent. The same
startup-scan regression, PTY interaction, identity, inventory, stop, stderr,
and root-removal gates apply. This lane stays outside `test:all` and changes no
production lifecycle.

The restart-shaped compiled mode first starts and safely stops one idle Host in
each strategy's persistent state root:

```sh
pnpm benchmark:quick-session:host-prewarm-compiled-cached
```

That seed models prior Host use before an ordinary Observer restart. Seed time
is recorded outside measured startup and must pass current identity, empty
inventory, clean stop, and stderr gates. The measured Host remains a new process
and the full prewarm, Worktrunk, PTY, and cleanup matrix is unchanged. This lane
stays outside `test:all` and does not hide seed time as a product win.

The actual-Observer companion moves only the candidate's cached Host ensure to
provider-registry construction inside `runObserverMain`:

```sh
pnpm benchmark:quick-session:host-prewarm-compiled-observer
```

The control starts the same measured Host only after Observer readiness. Both
arms run the real 49-worktree startup reconcile and require healthy ready state,
one scan, exact snapshot inventory, unchanged readiness and scan distributions,
the full PTY input acknowledgement, clean Observer and Host stops, and all root
removals. At least four candidate ensures must settle before readiness. Binary
build and the exact idle-Host seed remain recorded setup work outside timing;
the lane is opt-in and changes no production composition.

The live-Host restart lane models the external Host surviving an ordinary
Observer restart after prior PTY use:

```sh
pnpm benchmark:quick-session:host-observer-restart-live
```

Both arms first prove a current compiled Host spawn, exact PTY identity,
readiness, controller input acknowledgement, close, and empty inventory. The
control stops that Host and replaces it after Observer readiness; the candidate
keeps it healthy across the real 49-worktree Observer startup. Warmup is
recorded setup evidence outside timing. Measured ensure, new PTY interaction,
Observer readiness and snapshot, startup scan, spawn counts, both shutdowns,
stderr, and root removal remain hard gates. The lane is opt-in and changes no
production lifecycle.

The preserved-Host phase lane repeats only the live candidate ten times and
splits post-ready latency at adjacent monotonic boundaries:

```sh
pnpm benchmark:quick-session:host-observer-restart-phases
```

It records intent through ensure, health, spawn response, attach, child-ready,
and input-acknowledgement phases. Their nonnegative sum must match total intent
within 10ms, and a next target is attributed only when one phase owns at least
60% of total p95 and half of at least two samples over 100ms. The complete
warmup, Observer, Worktrunk, PTY, shutdown, stderr, and removal proof remains
unchanged. This opt-in lane adds no production instrumentation.

The cross-process companion launches the compiled `__observer` route instead
of sharing the benchmark worker's event loop:

```sh
pnpm benchmark:quick-session:host-observer-cross-process
```

Across ten runs, the parent accepts intent on its first healthy startup
response and immediately drives the preserved PTY-used Host. It splits caller
scheduling before `ensure()` from the ensure call and later Host/PTTY phases.
The ready snapshot must contain all 49 worktrees; intent p95 must be at most
100ms, pre-ensure scheduling p95 at most 10ms, ensure p95 at most 25ms, and
Observer startup p95 at most 1.5s. Child build identity, protocol stop and zero
exit, both stderr streams, PTY identity/input, inventories, and root removal are
mandatory. This opt-in lane changes no production process behavior.

The compiled native product-boundary lane starts at the actual CLI and raw
terminal input rather than an internal composition seam:

```sh
pnpm benchmark:quick-session:compiled-native-tui
```

It builds the current all-in-one binary outside timing, preserves one exact
PTY-used Host, and performs five ordinary Observer restarts against a
49-worktree repository. Each run measures CLI launch to native dashboard
readiness separately from raw Quick Session input through optimistic UI,
Observer command/trace evidence, Worktrunk mutation, Host child readiness,
canonical-row convergence, real pane focus, and input acknowledgement. Exact
build and PTY identity, repository/branch/harness/terminal binding, cleanup to
49 worktrees, UI/Observer/Host shutdown, stderr, and removal of the temporary
root are mandatory. The opt-in lane changes no production CLI or TUI behavior.

The native focus companion alternates the dashboard's existing raw Escape
dismissal with its unambiguous Ctrl-O overlay toggle:

```sh
pnpm benchmark:quick-session:compiled-native-focus
```

Across five samples per gesture it splits focus input, overlay disappearance,
pane input, and Host acknowledgement without changing Quick Session or focus
semantics. The same compiled restart, 49-worktree, command/trace, canonical UI,
Host/PTTY, cleanup, and shutdown proof applies. The single documented CLI
startup progress line is exact evidence in this lane; any additional UI stderr
or any Host stderr fails it. This opt-in attribution adds no production
instrumentation.

The one-run safety companion expands every compiled-native product-boundary
predicate into named artifact evidence:

```sh
pnpm benchmark:quick-session:compiled-native-safety
```

It uses the existing Ctrl-O path and preserves the same command, trace,
worktree, session, PTY, input, cleanup, shutdown, stderr, and root checks. The
lane diagnoses benchmark expectations only; it does not establish or change a
latency gate or production behavior.

The Host-entry diagnostic alternates the checkout's TypeScript source entry with
a one-time prebuilt Bun bundle:

```sh
pnpm benchmark:quick-session:host-entry
```

Bundle construction is recorded but excluded from cold-launch timing. Each arm
then performs compatible Host health, real Bun PTY spawn and attach, content-free
readiness, controller input acknowledgement, immutable identity, exact live and
empty inventories, clean stop, empty stderr, and root removal. The candidate
bundle may retain only runtime built-ins and carries the same controlling-terminal
helper layout as source mode. This diagnostic stays outside `test:all` and
changes no production Host command or packaging.

The installed-entry companion builds the current Station binary outside the
timing window and compares its compiled Host self-dispatch with source mode:

```sh
pnpm benchmark:quick-session:host-entry-compiled
```

Every measured Host gets fresh state, so compiled startup includes
content-addressed extraction and validation of its packaged controlling-terminal
helper. Both arms otherwise retain the Host-entry diagnostic's interaction,
identity, inventory, shutdown, stderr, and cleanup gates. Binary construction is
recorded as setup evidence and excluded from launch timing. This diagnostic
stays outside `test:all` and changes no production packaging.

The packaged-helper attribution mode compares the compiled binary's normal Bun
PTY preparation with its supported no-controlling-terminal diagnostic mode:

```sh
pnpm benchmark:quick-session:host-entry-compiled-assets
```

Both arms use the same current binary and fresh state; only embedded helper
extraction, validation, probe, and lease are omitted. Exact interactive behavior
is still measured, but `bun-nocctty` is attribution-only and cannot establish
terminal parity or become a production candidate. The lane stays outside
`test:all`.

The compiled milestone lane reads the existing strict `host.start` log record
before removing each fresh state root:

```sh
pnpm benchmark:quick-session:host-entry-compiled-milestones
```

It runs five full no-ctty interaction lifecycles and splits ensure into time
before Host initialization and time from `host.start` through polled health.
Adjacent wall-clock and monotonic samples must remain coherent within 25ms, and
all ordinary interaction and cleanup gates still apply. This attribution lane
stays outside `test:all` and adds no production instrumentation.

The dedicated-binary attribution lane compiles `hostMain.ts` into a temporary
Host-only executable and compares it with the installed all-in-one Station
binary:

```sh
pnpm benchmark:quick-session:host-entry-dedicated-binary
```

Both arms use no-ctty mode on fresh roots so executable startup remains isolated
from packaged-helper work. The temporary executable embeds the same build
version and identity, retains strict milestone and interaction gates, and is
removed after the run. Compilation is recorded outside launch timing. This lane
stays outside `test:all` and does not change shipped packaging.

The compiled sequence lane retains all 20 ordered samples from one newly built
all-in-one binary:

```sh
pnpm benchmark:quick-session:host-entry-compiled-sequence
```

It reports both the full distribution and positions 2–20, plus every sample
above 500ms, to distinguish one-time executable warmup from recurring cold-Host
tails. Each position still receives fresh Host state and the full milestone,
interaction, and cleanup proof. The lane stays outside `test:all`; the first
sample remains visible and is never discarded from raw evidence.

The end-to-end Quick Session diagnostic composes the retained real
Observer/Worktrunk benchmark with the real Station terminal adapter and a warmed
Bun Host:

```sh
pnpm benchmark:quick-session:end-to-end
```

It runs the same 49-worktree cold/warm, 3/5/20, and two-project matrix as the
fake-boundary lane. Each measured fixture starts only after Host health and one
setup-only spawn/attach/close warmup has restored empty inventory, and a
session is interactive only after exact attach identity, child readiness,
canonical projection, controller input, and child acknowledgement. The Host PTY
stays live through post-launch reconciliation, then the lane proves PTY close,
empty Host inventory, clean daemon shutdown, Git cleanup to 49 registrations,
empty stderr, and temporary-root removal. It is opt-in and remains outside
`test:all`.

The paired attribution lane counterbalances fake and real-terminal blocks while
keeping a healthy, runtime-warmed idle Host present for both:

```sh
pnpm benchmark:quick-session:end-to-end-paired
```

It reports provider blocking (queue, mutation, and authoritative observation)
separately from terminal work. This distinguishes active-PTY overlap from
same-window Git/process variance; the diagnostic classifies Host contention by
the preregistered real/fake provider-stage ratio, never by relaxing the absolute
end-to-end budgets. It doubles the matrix to 216 sessions and applies the same
identity, projection, scan, concurrency, Host, Git, and cleanup gates to both
boundaries.

The pre-push hook is intentionally lint-only. It does not replace `test:all` or
the focused gate required by the change.

## Test layout

- Workspace unit and integration tests live under `apps/*/test`,
  `packages/*/test`, or `integrations/*/*/test`.
- Cross-system tests live under top-level `tests/`.
- Repeatable performance matrices and their experiment artifacts live under
  `tests/performance/`; keep synthetic and opt-in real-provider results clearly
  distinguished.
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
