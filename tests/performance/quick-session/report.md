# Quick Session Performance Report

## Result and scope

The retained Quick Session pipeline makes the final session in a five-session
burst interactive in **137ms median / 138ms p95** at the real
Observer + Worktrunk + warmed Station Host boundary. All 216 sessions in the
paired fake/real-terminal matrix passed exact identity, canonical projection,
terminal input acknowledgement, scan, Git inventory, Host inventory, shutdown,
and cleanup checks.

The motivating production observation took 35.2 seconds to spawn the fifth
process and about 39 seconds to publish its canonical session; the user-visible
experience was approximately 45 seconds. The 39-second canonical observation
and 138ms controlled p95 differ by roughly 283x (the rounded 45-second
experience differs by roughly 326x). This scale comparison is directional, not
a controlled A/B: the historical run used a live checkout with cross-Observer
hook contention, while the final benchmark uses isolated 49-worktree
repositories, hooks-disabled creation, a healthy warmed Host, and direct
Observer invocation.

The 138ms result includes real Git worktree creation, exact post-create
verification, Observer command handling, a real Bun PTY, attach, child
readiness, canonical session projection, controller input, and child
acknowledgement. It does not include cold CLI launch, cold Observer startup, or
the native dashboard's post-create dismissal/focus gesture. Those product
boundaries were measured separately and remain explicit below.

Measurements were collected on 2026-08-25 on an Apple M4 with Git 2.50.1,
Worktrunk 0.72.0, and Bun 1.3.14.

## Evidence retention

The review branch keeps the repeatable benchmark sources, regression budgets,
and [experiment ledger](ledger.md). Generated JSON and one-off diagnostic
runners are not part of the PR diff. The complete redacted evidence set,
including every retained and rejected raw artifact, is preserved on the
[2026-08-25 evidence archive](https://github.com/jeremyodell/station/tree/archive/quick-session-performance-evidence-2026-08-25/tests/performance/quick-session).

The archive is the source for exact samples, machine load, resource deltas,
command/trace mappings, temporary-path redaction, and mechanical threshold
decisions quoted here. The ledger remains the source for every preregistered
hypothesis, planned files and JSDoc, invariant, keep threshold, result, and next
question.

## Original and final distributions

### Historical five-request observation

Five requests were accepted within about 0.9 seconds:

| Request | Queue wait | Create command | Process spawn from first request |
| --- | ---: | ---: | ---: |
| 1 | 0.0s | 2.8s | +2.9s |
| 2 | 2.7s | 6.3s | +11.3s |
| 3 | 8.9s | 9.6s | +21.1s |
| 4 | 18.0s | 5.3s | +28.0s |
| 5 | 23.2s | 8.8s | +35.2s |

The fifth canonical session appeared at about +39 seconds. There was no
historical controlled matrix for the other scenario shapes, so their honest
before/after comparison uses the deterministic virtual-monotonic baseline.

### Deterministic orchestration control

These values are virtual orchestration units expressed as milliseconds. They
hold provider mutation cost constant so scheduler, projection, and scan changes
are repeatable; they are not claims about user wall-clock latency.

| Scenario | Original p95 | Final same-policy p95 | Change | Original scans | Final scans |
| --- | ---: | ---: | ---: | ---: | ---: |
| Warm single | 28ms | 6ms | -79% | 3 | 2 |
| Cold single | 39ms | 17ms | -56% | 3 | 2 |
| Burst 3 | 76ms | 18ms | -76% | 7 | 3 |
| Burst 5 | 124ms | 22ms | -82% | 11 | 3 |
| Burst 20 | 526ms | 52ms | -90% | 41 | 4 |
| Two projects in parallel | 244ms | 26ms | -89% | 26 | 6 |
| Unrelated harness events | 131ms | 13ms | -90% | 12 | 3 |

The shipped post-launch scheduling control improves warm/cold/burst-5 p95 from
116/127/116ms to 6/17/10ms. In the real retained matrix, create-idle
coalescing yields exactly one startup scan and one verification scan per
project, independent of one-project burst size.

### Retained real Observer and Worktrunk boundary

This opt-in matrix uses real Worktrunk/Git processes and 49-worktree
repositories while replacing the terminal with an immediate exact fake. Each
scenario has three complete repetitions.

| Scenario | Median | p95 | Median throughput | Scans per run |
| --- | ---: | ---: | ---: | ---: |
| Warm single | 57ms | 60ms | 17.67/s | 2 |
| Cold single | 331ms | 343ms | 3.02/s | 2 |
| Burst 3 | 73ms | 75ms | 40.92/s | 2 |
| Burst 5 | 127ms | 127ms | 39.48/s | 2 |
| Burst 20 | 368ms | 397ms | 54.29/s | 2 |
| Two projects in parallel | 122ms | 127ms | 49.30/s | 4 |

Every scenario passed exact branch/path/registration evidence, immediate
worktree and session visibility, monotonic stage order, a four-create
per-project bound, post-verification convergence, cleanup back to 49 worktrees,
and temporary-root removal. Worktree-observation p95 was at most 2.2ms.

### Paired real-terminal boundary

This matrix counterbalances fake and real-terminal blocks while keeping a
healthy runtime-warmed Host present for both. The real-terminal block measures
the final child input acknowledgement:

| Scenario | Median | p95 | Median throughput |
| --- | ---: | ---: | ---: |
| Warm single | 66ms | 70ms | 15.12/s |
| Cold single | 267ms | 270ms | 3.75/s |
| Burst 3 | 79ms | 88ms | 38.09/s |
| Burst 5 | **137ms** | **138ms** | **36.49/s** |
| Burst 20 | 399ms | 445ms | 50.13/s |
| Two projects in parallel | 157ms | 794ms | 38.29/s |

All 216 outcomes were exact. The multi-project p95 records a real host-load
outlier rather than being discarded.

An independent, non-paired end-to-end run was noisier: warm 64/262ms,
cold 306/579ms, burst-3 83/91ms, burst-5 166/407ms, burst-20 525/1636ms,
and multi-project 156/170ms median/p95. Its preregistered additive
classification was rejected because Git/process stages slowed in the same
repetition. It is evidence that **138ms is the controlled paired p95, not a
promise that every loaded machine completes in 138ms**.

The isolated warmed Bun terminal stage measured 4/6ms for a warm single,
6/9ms for burst 3, 9/12ms for burst 5, and 28/32ms for burst 20. Cold Host
startup was 120/521ms and remains outside the warmed-session result.

## Stage-by-stage movement

The final column uses the paired real-terminal burst-5 p95. Stage p95s are not
additive because concurrent sessions overlap and each percentile can select a
different sample.

| Stage | Before | Final p95 | What changed |
| --- | --- | ---: | --- |
| Command admission | Fifth request waited 23.2s behind project-wide handlers | 73.4ms | Same-branch commands remain serialized; different branches share four cancellation-aware create slots per project. |
| Repository mutation | Each Worktrunk create took 2.8-9.6s | 93.1ms | Eligible hooks-disabled managed creates use native `git worktree add` plus strict verification; Worktrunk remains the fallback. |
| Worktree observation | Five command reconciles consumed about 13s; burst-5 required 11 synthetic scans | 1.65ms | The provider's returned observation is projected directly; one verification scan waits for global create idle. |
| Launch preparation and PTY spawn | Effectively immediate only after the slow create/reconcile sequence | 13.9ms | Launch starts from the authoritative narrow projection and uses the exact managed target. |
| Harness readiness | Not separately measured | 8.2ms | A real child-ready marker is required before usability. |
| Canonical projection | Fifth canonical row lagged final process spawn by about 3.8s | 0.028ms | Durable seed + worktree + terminal evidence publish the canonical session before background verification. |
| Optimistic removal / benchmark focus | Waited for canonical reconciliation | 4.0ms | Canonical events clear the optimistic state without another full graph scan. |
| Final burst outcome | About 39s to fifth canonical row; roughly 45s perceived | 138ms | The blocking sequence is now bounded Git mutation plus real terminal readiness, not repeated whole-graph work. |

## Winning design

Measurements selected five independently reviewable changes:

1. **Project successful launches before verification.** Observer commits the
   provider-neutral created-worktree observation, then commits the durable
   session seed, exact terminal target, canonical session, and Group placement
   immediately after launch succeeds. Full reconciliation is eventual
   verification and fallback, not a blocking prerequisite.
2. **Bound repository pressure at four creates per project.** One shared
   coordinator owns FIFO admission, cancellation, failure release, same-branch
   exclusion, and independent-project concurrency. Four beat serialized
   creation and the measured bounds of three, eight, and adaptive overflow.
3. **Coalesce graph verification at matching scope.** Project-idle and then
   global-idle evidence delays the all-project scan until all known creates
   drain. One burst now produces one post-start verification wave rather than
   one wave per command.
4. **Use native Git only for the proven no-hooks case.** When lifecycle hooks
   are explicitly disabled and Station has an exact managed path and base, the
   Worktrunk adapter runs native Git, then verifies absolute path, strict branch,
   and Git registration identity before returning high-confidence evidence.
   Every other shape retains the Worktrunk path.
5. **Close the Host attach response/frame race.** The client validates the
   immutable PTY identity and installs the attempt's frame sink while reducing
   the acknowledgement, before resolving the request promise. The baseline
   lost two ready markers in 150 completed sessions; the candidate lost zero in
   600.

The native-Git choice was decisive: for burst 5, Worktrunk versus native Git
wall time was 333/336ms versus 77/77ms median/p95 (-77%/-77%); for burst 20 it
was 980/1169ms versus 312/420ms (-68%/-64%). All compared runs preserved exact
registration, inventory, and cleanup.

## Deleted work and review shape

The architecture removes blocking work even though permanent safety and
benchmark coverage add code:

- Removed a full provider graph scan from the successful create/launch blocking
  path.
- Replaced per-command post-create verification waves with one coalesced
  post-burst wave.
- Narrowed project-wide command serialization to same-branch exclusion plus
  bounded repository mutation.
- Removed `wt switch`, its enriched command parsing, and its fallback list
  scan from the eligible hooks-disabled create path.
- Centralized stable Worktrunk worktree-ID derivation for native creation and
  discovery.
- Kept no parallel production pool, native removal path, structural startup
  path, Host prewarm path, or automatic dashboard-dismissal mechanism from
  rejected experiments.

The PR intentionally excludes 48 generated artifacts and one-off diagnostic
runners totaling more than 274,000 lines. They remain available in the evidence
archive. The final review diff contains 7,650 insertions and 160 deletions
across 43 files, with exactly five logical commits. Most additions are the
permanent benchmark matrix, real-boundary safety fixtures, and experiment
record; the production changes remain isolated by commit.

## Rejected experiments

The ledger has the complete preregistration and outcome for every experiment.
The most decision-relevant losers were:

| Family | Result | Decision |
| --- | --- | --- |
| Delete the 25ms interactive scheduler | Burst-20 p95 regressed 3,102→3,364ms, observation p95 reached 597ms, and scans stayed at 4/5/5 | Retain the interactive lane. |
| Raise per-project bound to 8 | Burst-5 was 412/1,020ms and burst-20 1,178/2,446ms median/p95 | Retain bound 4. |
| Lower bound to 3 | Burst-5 p95 regressed 141→167ms; burst-20 median regressed 405→480ms | Retain bound 4. |
| Adaptive overflow | Burst-20 regressed 264/382→306/425ms | End admission-bound tuning. |
| Remove or share native verification probes | Focused candidates missed gates; shared probes worsened burst-5 to 266/1,128ms | Keep independent strict verification. |
| Structural or deferred startup discovery | Cold improved materially, but burst-5 or warm p95 regressed as high as 853ms | Keep enriched startup discovery outside the launch optimization. |
| Pre-created worktree pool | A 20-slot prototype was fast, but the production-shaped and five-slot variants had 268-1,398ms tails and background fill cost | Do not add pool ownership or cleanup complexity. |
| Filesystem-only post-create verification | Typical command cost fell, but candidate-only burst-5 tail regressed 241% | Keep process-backed exact verification. |
| Native worktree removal | Large median wins, but burst-5 p95 improved only 35% against a registered 40% gate | Keep Worktrunk removal. |
| Host prewarm and alternate executable packaging | Several medians improved, but cold/startup p95 gates repeatedly failed; a dedicated 60MB binary worsened p95 | Do not add another lifecycle or binary. |
| Automatic/faster dashboard dismissal | Ctrl-O improved focus-to-ack 542/600→33/165ms, but missed the 100ms p95 and end-to-end gates | Keep current UX; investigate the tail separately. |

Every rejected production experiment was reverted. Diagnostic-only programs and
their raw artifacts are preserved only on the archive branch.

## Correctness and performance gates

The retained deterministic gate completed:

- Build, repository and Station typechecks, lint, and Observer architecture
  validation.
- 3,012 unit tests, 157 contract tests, and 738 integration tests.
- The permanent synthetic Quick Session performance and correctness matrix.
- 162 diagnostics tests and 5 scripted-agent tests.
- 28 setup E2E tests and 26 Observer E2E tests.
- Installer smoke and the pre-push lint hook.

Focused coverage proves immediate worktree/session/Group projection, event
publication, exact terminal binding, scheduler ordering, four-wide
coordination, FIFO admission, cancellation, failure release, same-branch
serialization, independent projects, create-idle reconciliation, native Git
path/branch/registration validation, Worktrunk fallback selection, error
redaction, Host response/frame ordering, and failed replacement behavior.

Real gates additionally prove exact Git registration and inventory restoration,
no more than four active creates per project, exactly two scans per project,
monotonic stages, command/trace mapping, correct harness and terminal identity,
child input acknowledgement, empty Host inventories after close, clean process
shutdown, empty stderr where required, and removal of all temporary roots.

Failure, cancellation after mutation, Observer restart recovery without an
invented session, canonical convergence, and removal convergence remain in the
permanent virtual matrix.

## Remaining costs and next frontier

The dominant warm/burst cost is now irreducible repository mutation for the
current new-worktree product meaning: native creation contributes roughly
55-93ms p95 per command in the retained real windows. A fifth request also
waits for the four-wide first wave, and a 20-session burst scales predictably
through five bounded waves. Worktree observation, canonical projection, and a
warmed terminal are no longer dominant.

Cold startup/discovery remains material: the retained cold p95 is 343ms at the
fake-terminal boundary, and isolated cold Host startup reached 521ms p95.
Structural/deferred reads and Host prewarming were not stable enough to ship.

The full compiled product boundary is the clearest next frontier. A five-run
single-session diagnostic measured:

- CLI launch to dashboard: 1,900/2,091ms median/p95.
- Intent to optimistic UI: 9.6/10.3ms.
- Observer command completion: 82.6/93.1ms.
- Host readiness: 127.5/255.4ms.
- Canonical UI: 168/282.9ms.
- Intent to focused input acknowledgement: 715/819ms.
- Full CLI launch to interaction: 2,701/2,903ms.

That diagnostic was mechanically rejected and changed no production TUI
behavior. The next experiment should isolate cold Observer/CLI startup and the
post-canonical focus/input tail with repeated product-boundary p95 evidence,
while preserving the retained 138ms burst path.

## User-visible behavior and manual verification

With Worktrunk lifecycle hooks explicitly disabled, an exact managed worktree
root, and a configured base, five different-branch Quick Sessions should open
as one bounded burst instead of serially waiting through five whole-repository
reconciliations. Each canonical session should identify the requested project,
branch, worktree, scripted harness, and Station Host target, and should accept
input as soon as its real PTY is ready. Hook-enabled or insufficiently
specified projects continue through Worktrunk.

To reproduce the controlled result:

1. Install Worktrunk 0.72.0, Git 2.50.1 or compatible, and Bun 1.3.14 or
   compatible; build Station with `pnpm build`.
2. Run `pnpm benchmark:quick-session:end-to-end-paired`. It creates isolated
   49-worktree repositories, a warmed Host, and both fake/real terminal blocks.
3. Confirm the report shows `burst-5` under the `host` boundary, every safety
   predicate passes, scan counts are `2,2,2`, and the benchmark removes its
   temporary repositories and Host state.

For a hands-on TUI check, configure the project with
`use_lifecycle_hooks = false`, a managed worktree root, and a base branch;
open its dashboard and invoke Quick Session five times on distinct branches as
quickly as the UI permits. Type a unique token into every focused pane, then
inspect `stn snapshot --json` to confirm five canonical sessions with the
expected project, branch, worktree, harness, and terminal identities. The exact
latency will vary with filesystem and machine load; the regression claim is the
repeatable benchmark boundary above.
