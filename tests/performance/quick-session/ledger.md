# Quick Session Performance Experiment Ledger

Synthetic timings below are orchestration controls. They are never presented as
user latency; real Worktrunk, Git, process, CPU, and I/O measurements are recorded
as separate experiments.

The review branch retains this complete decision record and the stable benchmark
runners. Every generated artifact and one-off diagnostic runner referenced below
is preserved on the
[2026-08-25 evidence archive](https://github.com/jeremyodell/station/tree/archive/quick-session-performance-evidence-2026-08-25/tests/performance/quick-session);
generated output is intentionally excluded from the PR diff. See the
[final report](report.md) for benchmark boundaries, consolidated distributions,
the winning design, and the remaining product-level frontier.

| ID | Hypothesis | Change | Baseline | Result | Correctness | Decision | Next question |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BENCH-000-W | A wall-clock synthetic lane will be stable enough to gate p95 orchestration latency. | Ran three complete matrices with real timers before retaining the lane. | Same synthetic costs and 49-worktree shape. | Rejected: p95 spread was 52% for burst-20 and 94% for unrelated-event contention; burst-5 spread was 83%. | Functional checks passed, but timings were dominated by unrelated host load. | Reverted as a performance gate; retained only as evidence that real runs must record machine load. | Can virtual monotonic time isolate orchestration while a separate real lane measures system cost? |
| BENCH-000 | The current Quick Session path can be reproduced with monotonic timestamps at every user-relevant boundary before production code changes. | Added an isolated virtual-monotonic matrix, statistics, raw baseline artifact, and CI-reachable gate. | Historical five-request run: final process +35.2s, final canonical row about +39s; current logs show 2.5–6.6s reconciles. | Synthetic p95: warm 28ms; cold 39ms; burst-3 76ms; burst-5 124ms; burst-20 526ms; multi-project 244ms; unrelated events 131ms. Three complete invocations had 0% p95 spread. The current path performs 3 scans for one warm request, 11 for burst-5, and 41 for burst-20. | All stages were monotonic; failure created no worktree; cancellation after mutation recovered the worktree after restart without inventing a session; five removals converged. | Keep. Synthetic results are orchestration units, not user latency. | Can a provider-returned worktree observation remove the first full reconcile from the blocking path? |
| EXP-001 | The worktree provider's successful create result is authoritative enough to publish a launch-bound worktree without blocking command completion on a full graph scan. | Serialized a narrow core projection from the returned provider-neutral `WorktreeObservation`, published `worktree.added`, retained full reconcile for worktree-only creates, and left post-launch verification on the existing scheduler. | BENCH-000: warm p95 28ms and 3 scans; burst-5 p95 124ms and 11 scans. Keep only if warm and burst-5 p95 each improve by at least 25%, warm scans equal 2, burst-5 scans are at most 7, and all correctness cases remain unchanged. | Three identical matrices: warm 16ms (−43%) and 2 scans; cold 27ms; burst-3 40ms; burst-5 64ms (−48%) and 6 scans; burst-20 265ms; multi-project 86ms; unrelated events 71ms. Warm throughput rose from 35.7 to 62.5 sessions/s and burst-5 from 40.3 to 78.1 sessions/s. | All stages remained monotonic; failure, cancellation/restart recovery without an invented session, and five-worktree removal matched BENCH-000. The integration slice proves launch-bound create publishes its row and counts with zero list scans. | Keep. | Post-launch full reconciles now dominate canonical projection and still scale once per session; can scheduler coalescing reduce burst scans without delaying canonical visibility? |
| BENCH-001 | The synthetic matrix needs the shipped 100ms scheduler policy as a separate control to measure fixed interactive wait against burst coalescing. | Retained the zero-debounce serialization lane and added production-debounce warm-single, cold-single, and burst-5 scenarios with the same repository shape and stage instrumentation. | EXP-001 zero-debounce: warm p95 16ms with 2 scans; burst-5 p95 64ms with 6 scans. | Production-debounce p95: warm 116ms, cold 127ms, burst-5 116ms. Warm and cold spend 110ms in canonical projection. Burst-5 coalesces to 2 scans but reaches only 43.1 sessions/s versus 78.1 in the raw zero-debounce lane. | Complete stage and correctness matrix passed. | Keep as the shipped scheduling control. | What low-latency scheduling policy beats the production control for warm and burst traffic without increasing scans? |
| EXP-002 | A 25ms interactive reconcile lane for external launch can preserve production burst coalescing without imposing the ordinary 100ms hook/metadata debounce on user-blocking canonical visibility. | Extended the shared scheduler with an interactive request that advances a pending ordinary flush and uses 25ms for both leading and post-run waits; successful external-launch preparation uses it while ordinary requests retain 100ms/1000ms policy. | BENCH-001: production warm p95 116ms, cold 127ms, burst-5 116ms and 2 scans. Keep only if warm and burst-5 are each at most 58ms, burst-5 remains at 2 scans, zero-debounce controls do not regress, and scheduler plus correctness gates pass. | Three identical matrices: production warm 41ms (−65%), cold 52ms (−59%), burst-5 41ms (−65%) with 2 scans. Production burst throughput rose from 43.1 to 122.0 sessions/s. Zero-debounce warm 16ms and burst-5 64ms were unchanged. | Scheduler tests prove an interactive request advances an ordinary timer and selects the short trailing delay behind an active run. External-launch and command integration slices passed; the complete failure/cancel/restart/removal matrix was unchanged. | Keep. | Does canonical projection remain the right blocking boundary, or can launch evidence be projected without a provider scan? |
| EXP-003 | A durable session seed plus provider-returned managed target and successful launch preparation are sufficient to project the canonical Station session without waiting for provider discovery. | Serialized a narrow row/session/Group projection after managed launch succeeds, published existing worktree/session events, and retained interactive scheduled reconciliation as eventual verification and fallback. | EXP-002 production: warm p95 41ms, cold 52ms, burst-5 41ms and 2 scans. Keep only if production warm is at most 12ms, burst-5 at most 28ms, eventual burst scans remain 2, zero-debounce controls improve or hold, and launch cleanup, Group, recovery, restart/removal, and event-refresh checks pass. | Three identical matrices: production warm 6ms (−85%), cold 17ms (−67%), burst-5 22ms (−46%) with 2 eventual scans. Canonical projection is 0ms. Production warm throughput reached 166.7 sessions/s and burst-5 227.3 sessions/s. Zero-debounce warm improved 16→6ms and burst-5 64→54ms. | Immediate integration assertions prove titled canonical session, exact terminal binding, and inherited Group membership before any provider list call. Event publication, scheduled spool drain, launch cleanup, recovery, failure, cancellation/restart, and removal checks passed. | Keep. | Project-scoped repository mutation serialization now contributes 16ms of the 22ms production burst-5 p95; can repository-safe concurrency improve it? |
| BENCH-002-C | Independent Worktrunk create processes may not provide the safety needed to narrow `worktree.create` below project scope. | Added an opt-in real lane and ran `wt` 0.72.0 create bursts of 3, 5, and 20 against isolated temporary Git repositories, three repetitions each, with hooks disabled and per-branch managed paths. | EXP-003 synthetic production burst-5: 22ms total, of which 16ms is project queue wait. Reject concurrent Station dispatch if any create fails, registrations/inventory are incomplete or duplicated, or cleanup does not converge. | All nine parallel runs returned exact unique output and Git inventory. Median serialized→parallel wall time: burst-3 353→161ms, burst-5 529→198ms, burst-20 3392→608ms. | No failed commands, missing/duplicate registrations, inventory mismatches, or leftover benchmark roots. Evidence is limited to Worktrunk 0.72.0, Git 2.50.1, hooks disabled, and simple repositories. | Keep as qualified evidence; do not change Station scope yet. | Does the same safety hold with Station-style lifecycle hook delivery enabled and contending? |
| BENCH-003-H | Worktrunk create concurrency may remain repository-safe when Station-style lifecycle hooks run for every create. | Repeated real 3/5/20 serialized and parallel bursts using an isolated Worktrunk config whose `post-create` and `post-switch` hooks append identity records to a repository-local log. | BENCH-002-C no-hooks parallel runs were safe and 2.2–5.6× faster by median burst wall time. Any create, inventory, hook-count, hook-identity, or cleanup failure rejects hooks-enabled concurrency. | All nine parallel runs returned exact Worktrunk output, Git inventory, and two hook records per branch. Median serialized→parallel wall time: burst-3 519→227ms, burst-5 869→516ms, burst-20 4994→1173ms. Parallel burst-5 p95 was noisy at 1338ms over three samples. | No create, inventory, hook-count, hook-identity, or cleanup failure. Evidence remains version/machine/repository-shape specific. | Keep as support for bounded—not unbounded—concurrency. | What per-project bound preserves cancellation and failure isolation while improving Station bursts? |
| EXP-004 | Four concurrent creates per project can remove Quick Session queueing while bounding repository and hook pressure. | Gave `worktree.create` a same-branch command scope and routed all four create-owning handlers through one shared cancellation-aware per-project coordinator capped at four. | EXP-003 production burst-5 p95 22ms (16ms queue wait); no production burst-20 control yet. Keep only if burst-5 is at most 12ms, burst-20 at most 30ms, observed in-flight creates never exceed four, same-branch/cancel/failure isolation passes, scans and correctness hold, and real evidence stays safe. | Three identical matrices: production burst-3 p95 7ms, burst-5 10ms (−55%), and burst-20 23ms; throughput was 428.6, 500.0, and 869.6 sessions/s respectively. Queue p95 is 0/4/16ms across those bursts, eventual scans remain 2, and warm/cold stay 6/17ms. Multi-project burst-6 reaches six global creates while each project peaks at three. | Every scenario stays at or below four active creates per project. Unit tests prove FIFO admission, aborted-waiter removal, failure release, and project independence; command integration proves same-branch serialization with different-branch overlap. The full failure, cancellation/restart, and removal matrix is unchanged. BENCH-002-C and BENCH-003-H provide qualified real Worktrunk evidence. | Keep. | Launch preparation/spawn is now the largest non-queue stage for typical production bursts; can its repeated preflight or terminal work be safely shared without hiding provider state? |
| BENCH-004-R | The retained Observer path can be measured end to end with real Worktrunk cost while fake terminal/harness boundaries isolate repository and Station orchestration. | Added an opt-in real Observer/Worktrunk lane with 49-worktree repositories, warm/cold single and 3/5/20 plus multi-project bursts, full stage timing, command/trace mapping, scan and concurrency counts, resource observations, post-reconcile convergence, and cleanup verification. | BENCH-002-C measures raw `wt` only; EXP-004 measures Observer orchestration only with virtual provider cost. Keep the benchmark only if every command succeeds with exact branch/path evidence, all timestamps are monotonic, eventual verification converges, per-project creates stay at or below four, and temporary repositories are removed. | Retained EXP-007 matrix median/p95: warm 150/153ms, cold 423/433ms, burst-3 179/180ms, burst-5 336/344ms, burst-20 954/968ms, multi-project burst-6 289/748ms. Median throughput is 14.88 sessions/s for burst-5, 20.96 for burst-20, and 20.80 across two projects. Worktree-observation p95 is at most 2.1ms and each scenario performs startup plus one verification scan per project. | Every raw command has a trace ID and monotonic stages; direct rows/sessions and post-reconcile 50/52/54/69/104-row convergence passed; the per-project peak is four; all Git inventories returned to 49 and the benchmark root was removed. | Keep. Encoded real gates: warm p95 500ms, burst-5 1500ms, burst-20 2500ms, worktree-observation p95 100ms, and exactly two scans per project. | Repository mutation plus the four-wide queue now dominates; can mutation cost or safe bound tuning improve typical burst-5 without increasing hook pressure? |
| EXP-005 | A full reconcile can overwrite a newer narrow worktree/session projection because its provider and persistence evidence was captured before its snapshot-writer commit. | Diagnostic only: moved the real fixture from Vitest's short `/tmp` symlink into its canonical sandbox root and separated missing evidence from identity/path disagreement before changing core. | Initial BENCH-004-R attempts reported changed path-derived IDs and one non-canonical immediate read under burst load. Keep a core change only if the condition reproduces with canonical paths and convergence polling. | Rejected: the `/tmp/st-*` alias and its canonical target produced two path-derived IDs for one Git worktree. With a canonical benchmark root, three burst-20 runs (60 sessions) preserved every direct worktree and prepared-session projection; no core race reproduced. | Exact opaque Git registration identity, direct projection visibility, bounded creates, eventual scans, and cleanup all passed after the fixture correction. | Revert the stale-commit hypothesis; no production change. Keep the canonical-root benchmark correction. | Five verification scans still contend with narrow projections; can the now-obsolete interactive scheduler lane be deleted? |
| EXP-006 | The 25ms interactive reconcile lane became obsolete once EXP-003 made canonical launch projection synchronous; deleting it should reduce scan waves without delaying interactivity. | Routed post-launch verification through the ordinary 100ms leading/1000ms backlog scheduler and removed the interactive request/configuration path for the experiment. | Canonical-root real burst-20: three runs, five total scans each; final-session p95 3102ms, worktree-observation p95 480ms, median throughput 8.50 sessions/s. Keep only if each run uses at most three total scans, worktree-observation p95 is at most 200ms, final p95 is at most 2482ms, all direct rows/sessions remain visible, and synthetic plus correctness gates hold. | Rejected: runs used 4/5/5 scans; worktree-observation p95 regressed to 597ms, final p95 to 3364ms, and median throughput to 6.26 sessions/s. The stable synthetic controls were unchanged because their 4ms mutations completed before either timer. | All 60 direct rows and sessions remained visible, per-project creates stayed at four, and cleanup converged, but every performance keep threshold failed. | Revert completely; retain the 25ms lane. | Scheduler delay alone cannot identify repository quiescence; can shared create-activity ownership defer verification until the project is idle? |
| EXP-007 | The shared create coordinator's project-idle transition can defer verification scans until a known repository burst is quiescent without delaying direct launch projection. | Exposed a project-idle promise, shared the coordinator between command handlers and Observer API composition, and asynchronously requested interactive verification only after that project became idle. | Canonical-root real burst-20: five total scans per run, final p95 3102ms, worktree-observation p95 480ms, median throughput 8.50 sessions/s. Keep only if every run uses exactly two total scans, worktree-observation p95 is at most 100ms, final p95 is at most 2482ms, all direct rows/sessions remain visible, and coordinator, external-launch, synthetic correctness, and cleanup gates pass. | Three-run focused matrix: exactly two scans per run; final p95 989ms (−68%); worktree-observation p95 2.2ms (−99.5%); median throughput 20.85 sessions/s (+145%). The retained full matrix improved further to 968ms burst-20 p95, 2.1ms observation p95, and 20.96 sessions/s. | All 60 focused rows/sessions were visible before verification and all three final snapshots contained 69 rows/20 sessions. Coordinator FIFO/cancel/failure/idle, external-launch deferral, synthetic failure/cancel/restart/removal, four-wide bound, trace, and cleanup checks passed. | Keep. | Repository mutation plus four-wide admission is now the dominant burst stage; what bound best balances burst-5 latency with Worktrunk/hook pressure? |
| EXP-008 | Raising the per-project provider-create bound from four to eight will remove one mutation wave from burst-5 and two waves from burst-20 without unsafe Worktrunk contention. | Temporarily changed only the coordinator default to eight and its bound-specific tests/docs, then restored four after measurement. | EXP-007 retained real matrix: warm p95 153ms, burst-5 p95 344ms with median throughput 14.88/s, burst-20 p95 968ms with median throughput 20.96/s, worktree-observation p95 at most 2.1ms, and exactly two scans per one-project scenario. Keep only if three same-shape real repetitions produce burst-5 p95 at most 275ms and burst-20 p95 at most 774ms (both at least 20% faster), median throughputs at least 17.85/s and 25.15/s, warm p95 at most 230ms, observation p95 at most 100ms, exactly two scans, and no correctness regression. | Rejected: eight-wide burst-5 median/p95 was 412/1020ms at 12.13/s and burst-20 was 1178/2446ms at 16.98/s; warm p95 was 683ms and multi-project observation p95 was 889ms. Current-load four-wide controls were also noisy (burst-5 518/1420ms at 9.66/s; burst-20 1303/2517ms at 15.34/s), but eight improved the same-host burst-20 median by only 10% and p95 by 3%, far below the registered 20%, while one-minute load averages differed (candidate 28–37, controls 21–25). | All exact identities, direct projections, two-scan convergence, final inventories, and cleanup passed; peaks were five/eight as predicted. The synthetic lane improved burst-5 10→7 and burst-20 23→15 units, but it did not reproduce Worktrunk CPU/I/O contention. | Revert completely; retain four. Raw candidate and same-host controls make the rejection auditable. | Profile the Worktrunk subprocess and Git child work under load before changing repository pressure again. |
| BENCH-005-P | Station's repeated bare-check Git subprocess may be a material avoidable fraction of provider mutation time, or the cost may be opaque inside `wt switch`. | Wrapped the real fixture's injected external-command runner and recorded only classified command kind, duration, and success for each top-level provider subprocess. | EXP-007 burst-20 mutation p95 203ms per command and final p95 968ms; the provider performs one `git config core.bare` probe before each `wt switch`. Treat the probe as actionable only if its p95 is at least 10% of mutation p95 or its summed duration is at least 10% of summed top-level create duration; otherwise attribute the dominant cost to Worktrunk and its opaque Git children. | In the first profiled matrix, bare-probe p95/aggregate shares were 7.6%/8.0% for burst-5 and 7.5%/6.7% for burst-20; `wt switch` represented 92–93% of summed create subprocess time. Under a second high-load matrix, burst-20 bare-probe p95 reached 15.1% while its aggregate share remained 9.4%, so the registered p95 threshold was crossed only under contention. | All classified commands succeeded and the profiles contain no args, paths, environment, or output. Exact identity, two scans, convergence, inventory, and cleanup passed, but the second matrix correctly failed the 100ms observation budget when a global reconcile delayed two multi-project projections by 1.12s (traces `trc_e262aed3-7970-42db-badb-819150eecdea` and `trc_f3b2ed39-545d-4791-b649-f04aec418c79`). | Keep the safe diagnostic fields. The probe is a qualified later target, while Worktrunk remains dominant. | Fix the higher-impact cross-project verification race, then isolate the bare probe and a narrow native-Git create prototype. |
| EXP-009 | A project-idle signal is insufficient for a global full reconcile: one project can start verification while another still has active creates, blocking those narrow projections behind the snapshot writer. | Added a process-global idle promise to the shared create coordinator and used it for global post-launch verification; retained project-idle for narrower consumers and kept direct launch projection non-blocking. | High-load multi-project run: observation p95 1120ms and final p95 1594ms; two project-1 commands spent 1119/1120ms after mutation while a scheduler run took 1141ms with work queued behind it. Retained ordinary matrix was 1.8ms observation p95 and 748ms final p95. Keep only if three targeted matrices (nine runs) start no verification scan while any create is active, observation p95 is at most 100ms in every matrix, final p95 is at most 1000ms, exactly four scans occur per run, and all existing gates pass. | Three targeted matrices produced observation p95 2.0/2.6/3.5ms and final p95 279/487/548ms. All 36 scans across nine runs started with zero active creates and every run used four scans. The full matrix passed: warm 411ms, burst-5 580ms, burst-20 1219ms, and multi-project 275ms final p95; observation p95 was at most 2.8ms. | Global/project idle ordering, cancellation/failure release, direct visibility, exact 104-row/6-session convergence, synthetic failure/cancel/restart/removal, command profiles, inventories, and cleanup passed. | Keep. The global scan now waits on evidence matching its all-project scope. | Is a native-Git no-hooks create materially faster than Worktrunk while returning equally strong identity evidence? |
| BENCH-006-G | For explicitly hooks-disabled automation, native `git worktree add` may provide the same exact mutation fact much faster than Worktrunk's broader switch workflow. | Ran paired, alternating-order bounded-four Worktrunk and native-Git bursts of 3/5/20 on fresh repositories with 49 initial worktrees, five repetitions each. | BENCH-005-P attributes about 90% of summed create subprocess time to `wt switch`; retained Observer final p95 is 580ms for burst-5 and 1219ms for burst-20 under the latest load. Treat native Git as a production candidate only if median and p95 wall time improve by at least 40% for both burst-5 and burst-20. | Burst-5 Worktrunk→Git median/p95 was 333/336→77/77ms (−77%/−77%); burst-20 was 980/1169→312/420ms (−68%/−64%). Median throughput rose 15.01→65.34/s and 20.42→64.13/s respectively. Burst-3 improved 193/203→43/48ms. | All 150 commands succeeded. Every run had exact branch/path registration, initial+burst unique inventory, peak concurrency min(4, burst), cleanup back to 49, and temporary-root removal. Evidence is explicitly hooks-disabled, Git 2.50.1, Worktrunk 0.72.0, and this repository shape. | Keep as decisive production-candidate evidence. | Add a provider-private no-hooks fast path with post-create native identity verification and Worktrunk fallback for hook-owned, unmanaged-path, or unresolved-base mutations. |
| EXP-010 | When lifecycle hooks are explicitly disabled and Station has an exact managed path and base, the Worktrunk adapter can use native Git for creation and still return provider-authoritative identity evidence. | Added an adapter-private native create/verify module, centralized path-derived worktree ID generation, and retained Worktrunk for every ineligible mutation. | Latest retained real Observer p95: warm 411ms, burst-5 580ms at 12.82/s, burst-20 1219ms at 16.98/s; BENCH-006-G predicts 64–77% raw mutation improvement. Keep only if real p95 improves at least 40% to ≤348ms for burst-5 and ≤731ms for burst-20, warm p95 is ≤250ms, observation p95 is ≤100ms, scan counts remain exact, and all fallback/correctness gates pass. | Warm median/p95 was 57/60ms; burst-5 was 127/127ms at 39.48/s (−78% p95, +208% throughput); burst-20 was 368/397ms at 54.29/s (−67% p95, +220% throughput). Cold p95 was 343ms and multi-project p95 was 127ms. Worktree-observation p95 was at most 2.2ms, every no-hooks create used one native add and verification with zero `wt switch` calls, and each scenario retained exact two-scans-per-project convergence. | Exact verified path/branch/registration identity, stable ID convergence with later Worktrunk scans, hooks-enabled/external-path/base-less fallback, actionable duplicate and verification errors, native seeding, direct projection, global-idle scanning, final inventories, and cleanup passed. The stable matrix retained failure, cancellation/restart recovery without an invented session, and removal behavior. The complete repository gate passed 3,012 unit, 157 contract, 738 integration, 162 diagnostic, 5 scripted-agent, 28 setup-E2E, and 26 Observer-E2E assertions plus install smoke; persisted `master`/`trunk` defaults now exercise native creation end to end. | Keep. | Can one of the remaining per-create Git proofs—bare configuration or post-create verification—be eliminated or shared without weakening exact identity and mid-run safety? |
| BENCH-007-G | Native Git's narrower create operation may tolerate eight concurrent per-project mutations even though Worktrunk's broader workflow did not. | Ran paired, alternating-order bounds of four and eight against fresh 49-worktree repositories for bursts of 3/5/20, five repetitions each, without changing production admission. | BENCH-006-G native bound-four median/p95 wall time: burst-5 77/77ms and burst-20 312/420ms. Advance bound eight only if burst-5 median and p95 improve by at least 15%, burst-20 median and p95 improve by at least 20%, and every safety condition passes. | Rejected: paired burst-5 bound four→eight median/p95 was 93/168→88/157ms, only 5.6%/7.1% faster. Burst-20 was 305/342→332/400ms, 8.8%/16.9% slower. Burst-3 p95 also regressed 93→117ms. All registered timing thresholds failed despite alternating candidate order. | All 30 candidate/control runs succeeded with exact unique path/branch registration, expected peak concurrency, initial+burst inventory, cleanup back to 49, and confirmed temporary-root removal. Safety alone was insufficient to retain the slower pressure policy. | Reject production bound eight; keep the reproducible diagnostic and raw evidence. | Can one of the remaining per-create Git proofs—bare configuration or post-create verification—be replaced with equivalent filesystem evidence? |
| EXP-011 | The post-create `git rev-parse` subprocess duplicates facts encoded by the linked-worktree registration files that native Git just wrote. | Replaced only that subprocess with strict, bounded reads of the worktree `.git` pointer, administrative backlink, and symbolic `HEAD`, while retaining opaque registration identity and the pre-create bare guard; then restored the subprocess after measurement. | EXP-010 p95: warm 60ms, burst-5 127ms, burst-20 397ms. Verification costs 10.7/12.1/13.6ms p95 respectively and 159ms aggregate per burst-5 matrix sample set, 675ms per burst-20 set. Keep only if warm p95 is ≤54ms and burst-5/burst-20 p95 are ≤114/357ms (at least 10% faster), with exact scans and correctness intact. | Rejected. A focused warm probe reached 51/59ms median/p95, missing the 54ms gate. The full high-load matrix produced warm 66/145ms, burst-5 124/343ms, and burst-20 411/873ms; even the burst medians improved only 2% or regressed. All create-verification subprocess counts were zero, but none of the registered end-to-end p95 thresholds passed. | Strict marker/backlink/HEAD, size-bound, branch/path, native seed, fallback, exact projection, two-scans-per-project, inventory, cleanup, and stable synthetic failure/cancellation/restart/removal gates passed. The candidate was correct but not a measured latency win under the registered rule. | Revert completely; retain raw losing real/synthetic evidence. | The bare guard is now the only non-mutation subprocess, but changing it needs a cache invalidation proof strong enough to detect mid-run Git configuration changes. |
| EXP-012 | Concurrent creates for the same project can share one currently executing bare-check probe without caching its result across mutation waves. | Deduplicated only the in-flight `core.bare` promise by exact project/root identity and deleted it on settlement; list, remove, doctor, and every later create wave retained a fresh check; then restored independent checks after the focused gate. | EXP-010 p95: warm 60ms, burst-5 127ms, burst-20 397ms. Bare probes cost 10.6/12.9/13.7ms p95 and currently run once per session. Keep only if burst-5/burst-20 p95 are ≤114/357ms (at least 10% faster), warm p95 is ≤90ms, probe counts equal coordinator waves per project, observation p95 is ≤100ms, and exact scans/correctness hold. | Rejected at the focused burst-5 gate: median/p95 regressed from 127/127ms to 156/157ms, missing the 114ms threshold. The candidate did reduce create probes from five to two per run; the recorded nine total samples across three runs correctly include one additional intentionally fresh verification-scan guard per run. Reduced subprocess count did not translate into user latency under load. | Forty-four provider tests proved overlapping success and rejection sharing, deletion after settlement, and rejection after a mid-run bare change. All 15 creates, direct projections, exact two-scan convergence, final inventory, and cleanup passed; the stable failure/cancellation/restart/removal matrix also passed. | Revert completely after the focused gate; retain raw losing real/synthetic evidence. | Repository mutation remains dominant; further proof deletion or guard sharing is unjustified without a different source of evidence. |
| BENCH-008-L | Worktrunk's enriched 49-worktree inventory is the dominant cold-start cost; native Git may expose the exact structural inventory much faster. | Ran paired alternating-order `wt list --format=json` and `git worktree list --porcelain -z` on five fresh 49-worktree repositories, without changing production discovery. | EXP-010 cold p95 is 343ms; startup Worktrunk scans cost 189–268ms while the subsequent create mutation costs 58ms p95. Advance native structural discovery only if paired median and p95 list wall time improve by at least 80% and every inventory fact is exact. | Worktrunk→native median was 295→19ms (−93.7%) and p95 was 344→24ms (−93.1%), passing both 80% gates. Native samples were 16–24ms; Worktrunk samples were 255–344ms despite alternating order. | All ten commands parsed successfully with exact 49-entry unique path/branch inventory, primary checkout, one detached, one locked, and one prunable registration. Every temporary root was confirmed removed. Native Git deliberately supplied no dirty/ahead/behind enrichment. | Keep as decisive production-candidate evidence. | Can startup publish exact native structural rows and defer Worktrunk-only enrichment without changing command readiness or current-state correctness? |
| EXP-013 | Observer startup needs exact current worktree structure for readiness, but it need not block on Worktrunk-only dirty/ahead/behind enrichment. | Added an optional provider-neutral structural-list port, selected it only for exact `observer.startup`, implemented strict native Git structural discovery in Worktrunk, and restored the prior enriched-only production path after the registered gate failed. | EXP-010 median/p95: cold 331/343ms, warm 57/60ms, burst-5 127/127ms, burst-20 368/397ms. Keep only if cold p95 is ≤172ms, structural scan p95 ≤75ms, warm/burst-5/burst-20 p95 ≤90/153/477ms, observation p95 ≤100ms, and exact scan/correctness gates pass. | Rejected despite the predicted cold win. A focused cold run reached 98/115ms median/p95 with 36/38ms structural scans. The checked full confirmation reached warm 58/61ms and cold 91/94ms, but burst-5 was 182/299ms and burst-20 was 509/877ms, missing 153/477ms; structural p95 also exceeded 75ms in burst-3/5/20 at 142/77/82ms. A separate full run failed warm at 108/317ms during a host-wide 4–6× subprocess spike; a focused warm confirmation recovered to 56/59ms. | Forty-seven provider tests and ten Observer integration tests passed while the candidate was present, covering stable identity, primary/detached/locked/prunable evidence, absent enrichment, strict malformed/failure handling, managed filtering, startup selection, immediate later enrichment, and fallback. The stable correctness matrix passed; all 108 full-matrix creates had exact inventory, two scans per project, convergence, and cleanup. | Revert completely under the preregistered all-scenario rule; retain raw losing real/synthetic evidence. | Can a randomized paired end-to-end design separate the repeatable cold-start win from host-wide process variance before another production attempt? |
| BENCH-009-E | The cold real lane can mistake Observer startup's reconcile event for post-launch verification and begin cleanup while the actual enriched scan is still running. | Subscribed to reconciliation events only after cold startup completes; no production behavior changed. | The first EXP-013 cold probe reported `scanCount=2` but captured only one completed profile in its third repetition and no Worktrunk-list sample because it consumed the startup event. | Corrected probes captured both completed scans per project/repetition, the expected Worktrunk-list samples, and no cleanup overlap. The retained control then completed the full corrected matrix with exact scans; one warm outlier made p95 509ms against its broad 500ms guard while median remained 67ms, burst-5 p95 was 152ms, and burst-20 p95 was 529ms. | Exact final snapshot, inventory, and cleanup assertions now run after the intended post-launch event. | Keep as a benchmark correctness fix independent of EXP-013; do not replace the retained EXP-010 artifact with the noisy control rerun. | Use alternating in-run control/candidate pairs so host-wide process variance cannot select the next production attempt. |
| BENCH-010-P | Alternating the enriched and structural startup strategies in the same fresh repository can distinguish the structural treatment from host-wide subprocess variance that invalidated EXP-013's cross-run absolute comparison. | Ran five paired repetitions in alternating order for cold/warm singles and 3/5/20 native-create bursts, restoring the exact 49-worktree shape between strategies. | EXP-013 focused/full cold p95 was 115/94ms versus EXP-010 343ms. Advance another production attempt only if paired cold median and p95 improve by at least 50%, structural list p95 is ≤75ms, candidate warm/burst-3/5/20 p95 is no more than 20% slower than its paired control, and all exactness gates pass. | Rejected for production advancement. Enriched→structural cold median/p95 improved 263/287→68/81ms (74%/72%), and structural read median/p95 was 17/72ms. Warm p95 regressed only 10%, burst-3 improved 4%, and burst-20 improved 19%, but burst-5 regressed 135/310→169/853ms. Its structural-first repetitions coincided with 2–5× native command spikes that subsided during the following enriched read, so alternating order did not normalize subsecond host swings; the registered ≤20% gate failed at 175%. | All 50 startup reads and 300 creates/verifications succeeded with exact starting/created inventories, unique paths/branches, expected peak bound four, cleanup to 49 after each strategy, and all five temporary roots removed. No raw temporary paths are retained. | Keep the reproducible diagnostic and raw evidence; do not retry the production structural-startup path. | Can the now-dominant retained mutation be improved through a semantic change rather than deleting another small proof or relying on volatile subprocess timing? |
| BENCH-011-H | A hybrid policy can publish structural cold readiness, then perform enriched discovery before genuinely warm work (or after immediate creates become globally idle), preserving the cold win without structural-only cache penalties. | Extended the paired diagnostic with a hybrid candidate that uses structural-only discovery for cold timing and structural-then-enriched preparation before warm/burst mutation; alternated against the enriched control on five fresh 49-worktree repositories. | BENCH-010-P cold improved 72% p95, but structural-only burst-5 failed the ≤20% regression gate. Advance a production hybrid only if cold median/p95 improve by at least 50%, structural p95 is ≤75ms, hybrid warm/burst-3/5/20 p95 is no more than 20% slower than control, and every exactness gate passes. | Rejected. Enriched→hybrid cold median/p95 improved 265/1235→81/229ms (69%/81%), and structural median/p95 was 18/67ms. Burst-5 improved 6% p95, but warm regressed 57→368ms, burst-3 88→341ms, and burst-20 645→1030ms. Hybrid preparation p95 reached 803/541/958ms in those scenarios, increasing exposure to the same rapid host stalls rather than insulating mutation from them. | All 75 strategy reads and 300 creates/verifications succeeded with exact preparation and final inventories, unique paths/branches, bound four, cleanup to 49 after each strategy, and all five temporary roots removed. | Keep diagnostic and evidence; do not implement deferred startup enrichment. | Test a semantic path that removes mutation from user latency instead of rearranging startup subprocesses. |
| BENCH-012-W | A persisted pool of clean detached worktrees can satisfy Quick Session by activating an existing registration into the requested branch, removing `git worktree add` from user latency. | Compared retained native add/verify with pooled `git switch --create` activation in alternating order on five fresh repositories containing 49 ordinary plus 20 pool registrations; ran singles and 3/5/20 bursts at bound four, reset slots between strategies, and recorded pool-fill separately. | EXP-010 retained p95 is warm 60ms, burst-5 127ms, burst-20 397ms. Advance a product prototype only if pooled single median/p95 improve at least 25%, burst-5 and burst-20 median/p95 improve at least 30%, and every safety condition passes. | Passed. Native→pooled median/p95 was 56/60→33/36ms for single (40%/39%), 171/727→88/158ms for burst-5 (49%/78%), and 450/597→217/413ms for burst-20 (52%/31%). Median throughput rose 17.9→30.0/s, 29.2→57.0/s, and 44.5→92.1/s. Burst-3 median improved 47%, though one pooled host outlier made its unregistered p95 358ms. Filling 20 slots cost 176/272ms median/p95 and remains explicit background work. | All 40 strategy runs, 290 activations/creates, bare guards, and exact path/branch verifications passed with unique inventories, expected bound four, reset to clean detached base, branch deletion, cleanup to 69 after every strategy, and all five temporary roots removed. | Keep as decisive product-prototype evidence. | What minimal provider-private pool ownership metadata can keep reserved slots invisible, restart-safe, and replenished without blocking users? |
| EXP-014 | Provider-private, persisted detached slots can remove `git worktree add` from launch-bound interactive creation while staying invisible and falling back safely when no exact slot is available. | Implemented provider-neutral interactive intent and a disabled-by-default Worktrunk pool with strict atomic ownership, exact claim/activation verification, restart reuse, fail-open discovery, and post-scan bound-four replenishment; enabled 20 slots only in the real fixture, then mechanically removed the candidate after measurement. | EXP-010 median/p95: warm 57/60ms, burst-5 127/127ms, burst-20 368/397ms. Keep required real warm ≤43/54ms, burst-5 ≤95/114ms, burst-20 ≤276/357ms, cold p95 ≤450ms, pool-fill p95 ≤300ms, observation p95 ≤100ms, exact two-scan convergence, and all safety gates. | Rejected. A focused warm probe passed at 40/42ms with fill p95 246ms, but the preregistered full run measured warm 44/268ms, cold 540/585ms, burst-5 97/268ms, burst-20 263/267ms, and pool fill 365/425ms. Only burst-20 met both latency thresholds; warm median, warm/cold/burst-5 p95, burst-5 median, and fill p95 failed. Synthetic remained 6/17/22/52ms for warm/cold/burst-5/20. | All 108 creates used unique pooled activations with zero fallback adds and 108 post-scan replacements. Exact two-scan convergence (four for two projects), observation p95 ≤2.2ms, bound four, restart preparation, hidden/corrupt/stale behavior, atomic claims, existing-branch preservation, inventories, and cleanup to 69 passed; 47 Worktrunk and 60 Observer focused tests passed. | Reject and mechanically revert all candidate code/tests/fixture changes; retain only EXP-014 synthetic/real evidence and this ledger result. | Pooling removes native-add latency but adds persistent disk/scan cost and remains vulnerable to host subprocess stalls; seek wins that reduce subprocess count without 20 extra registrations. |
| BENCH-013-V | Git's linked-worktree administrative files can prove the exact newly created path, branch, and stable registration without spawning the retained post-create `git rev-parse` process. | Alternated retained rev-parse verification against strict filesystem verification on five fresh 49-worktree repositories for single and 3/5/20 bursts at bound four, restoring the exact shape after each strategy. | Advance EXP-015 only if filesystem verification p95 is ≤2ms; single median/p95 improve ≥12%; burst-5 median/p95 improve ≥10%; burst-20 median/p95 improve ≥8%; burst-3 does not regress; and all safety checks pass. | Rejected for production advancement. Process→filesystem verification took 10.3/11.7→0.34/0.55ms for singles and wall time improved 50.6/54.6→40.8/43.0ms (19%/21%). Burst-3 improved 13%/18% and burst-20 33%/39%. Burst-5 median improved 29% (135→96ms), but a 588ms candidate-only host stall versus 172ms control made p95 regress 241%, failing the registered ≥10% gate. | All 290 creates passed exact target/admin/ref/backlink/double-stat/identity or process verification, bare guards, unique paths/branches, bound four, exact created inventories, cleanup to 49 after every strategy, and removal of all five roots. | Keep the diagnostic and evidence, but do not retry or advance the already-rejected filesystem-verification production path. | Native add is near the warm lower bound; can cold Observer readiness stop awaiting discovery that direct launch truth does not consume? |
| BENCH-014-D | Cold Quick Session can become interactive from project configuration plus provider-returned create evidence before the initial enriched discovery scan, then converge through that scan without hiding work needed by the user's next action. | Extended the alternating paired startup diagnostic with a deferred candidate that timed native create/verification before enriched discovery, then required the post-interactive enriched read to observe the exact created inventory; compared cold/warm and 3/5/20 bursts on five fresh 49-worktree repositories. | Advance an Observer prototype only if cold median/p95 improve ≥60%, deferred enriched-read p95 is ≤700ms, warm and burst p95 regress no more than 20%, and every initial/created/post-read/cleanup/concurrency/root-removal gate passes. | Rejected for production advancement. Enriched→deferred cold median/p95 improved 267/763→51/195ms (81%/74%), and deferred discovery median/p95 was 238/611ms overall. Burst-3/5/20 p95 held or improved, but warm p95 regressed 82→232ms (184%) because one candidate mutation took 232ms, failing the registered 20% regression gate despite ordinary warm candidate samples of 51–54ms. | All 50 enriched reads and 290 creates/verifications succeeded with exact initial or post-create inventories, unique paths/branches, bound four, cleanup to 49 after each strategy, and all five temporary roots removed. All 162 diagnostics tests and the focused syntax/format checks passed. | Keep the diagnostic and raw evidence, but do not retry or authorize an Observer readiness prototype. Production remains EXP-010. | Can Quick Session reuse a provably suitable existing checkout so the common semantic path performs no repository mutation at all? |
| BENCH-015-T | The real Station Host PTY boundary is small enough that the fake terminal in the retained Observer benchmark does not conceal the next dominant Quick Session bottleneck. | Drove source bridge and compiled-style Bun PTYs through the real Host socket, immutable attachment identity, child-ready marker, controller write, and child acknowledgement for cold/warm singles and 3/5/20 bursts. The harness preserves the short sandbox socket alias and canonicalizes only child identity. | Classify the production Bun path as non-dominant only if cold host-start-to-ack p95 is ≤300ms, warm intent-to-ack p95 is ≤30ms, burst-5 final-ack p95 is ≤75ms, burst-20 final-ack p95 is ≤250ms, and every identity/input/cleanup gate passes. Prediction: Bun is ≤25/60/200ms for warm/burst-5/20 and bridge is measurably slower because it launches one bridge process per PTY. | Rejected before classification. Two independent post-setup runs spawned and attached a Bun PTY but lost its unique ready marker for more than 5s. The partial checked artifact completed 150 safe sessions: Bun warm 8/68ms, burst-5 18/28ms, and burst-20 56/137ms over two runs; bridge warm 130/156ms, burst-5 189/197ms, and burst-20 750/1222ms over three. Bun cold host-start samples were 374/1067ms, already above the 300ms gate. | Every completed session had monotonic spawn/attach/ready/input/ack stages, exact immutable identity, controller-only accepted input, exact live inventory, proven close, empty cleanup inventory, clean Host stop, empty stderr, and removed root. The missing-marker sessions fail the mandatory readiness condition; the existing real Bun PTY smoke tests still pass, narrowing the fault to attach-time output ordering under burst churn. | Keep the diagnostic and partial raw evidence; do not classify the real terminal boundary or compose it into EXP-010 yet. | Can installing a validated attachment sink synchronously while the attach response is reduced eliminate the response-to-continuation frame-loss window? |
| EXP-015 | A Host live frame arriving immediately after a valid `host.attach` response can be reduced before the awaiting `attach()` continuation registers its sink, silently dropping first-ready output. | Added a deterministic no-yield response/frame regression, then made the pending response reducer synchronously validate the acknowledgement and install the attempt sink before resolving the request promise; a failed replacement retains the prior sink. | BENCH-015-T produced two Bun ready-marker timeouts over 5s while 150 completed sessions were exact. The deterministic test reproduced the drop without its prior yield. Two complete candidate matrices then delivered all 600 sessions without a marker loss. Confirmation Bun median/p95 was 4/6ms warm, 9/12ms burst-5, and 28/32ms burst-20; the first matrix p95 was 31/66/68ms. All preregistered ≤100/100/300ms gates passed. | The immediate frame is delivered exactly. All 49 Host unit tests, 67 focused Station Host/terminal tests, 3,012 repository unit tests, 162 diagnostics tests, repository/Station typechecks, and builds passed. In the checked 300-session matrix, all identities, controller writes, acknowledgements, live/empty inventories, closes, ten Host shutdowns, stderr checks, and temporary-root removals were exact. | Keep. The generic BENCH-015-T classification remains false because cold Host-start p95 was 521ms, but Host startup is outside EXP-015's attach-ordering gate. | Real warmed Bun PTY readiness is a 6/12/32ms p95 additive stage; can composing it with EXP-010 prove the true end-to-end Quick Session distribution while keeping daemon startup separate? |
| BENCH-016-E | The retained EXP-010 Observer/Worktrunk path and warmed real Bun Host PTY remain approximately additive when composed, so the fake terminal/harness benchmark is not concealing cross-boundary contention. | Ran the existing real Observer matrix with native no-hooks Worktrunk mutation, the real Station terminal adapter, a healthy/runtime-warmed Bun Host, exact ready/input/ack shell harness, canonical verification, and complete PTY/repository cleanup. | EXP-010 fake-boundary median/p95 is 57/60ms warm, 331/343ms cold Observer, 127/127ms burst-5, and 368/397ms burst-20. EXP-015 warmed Bun p95 is 6/12/32ms for warm/burst-5/20. Composition was required to stay ≤100/450/200/550ms p95. | Rejected as additive. End-to-end median/p95 was 64/262ms warm, 306/579ms cold, 83/91ms burst-3, 166/407ms burst-5, 525/1636ms burst-20, and 156/170ms multi-project. The one slow repetition inflated Worktrunk/process stages too: warm mutation p95 215ms; burst-5 queue/mutation p95 204/293ms; burst-20 queue/mutation p95 1289/445ms. Real launch/readiness/input p95 also reached 33/14/138/210ms for warm/cold/burst-5/20. | All 108 sessions passed monotonic stages, exact Host identity, ready marker, controller acknowledgement, immediate projection, post-reconcile survival, two scans per project, bound four, PTY close/empty inventory, Git cleanup to 49, and all 18 Hosts passed health/shutdown/stderr/root-removal gates. | Keep the diagnostic and artifact; reject the additive classification mechanically and do not retry its thresholds. No production change. | Can a same-window alternating fake-versus-Host comparison distinguish Host-induced cross-boundary contention from unrelated process/filesystem tail noise? |
| BENCH-017-A | Active Host PTY work overlaps later repository mutations in bursts and causes BENCH-016-E's non-additive provider-stage tail, rather than that tail being unrelated subprocess/filesystem variance. | Ran counterbalanced adjacent fake-versus-real-terminal blocks on the same shaped projects; both modes received an equally healthy/runtime-warmed idle Bun Host, while only real mode spawned session PTYs. Reported provider and terminal distributions separately. | BENCH-016-E's per-sample queue + mutation + observation p95 was 225ms warm, 392ms burst-5, and 1512ms burst-20. Host-induced contention required real/fake provider p95 ratios ≥1.25 for both burst-5 and burst-20. | Rejected. Provider p95 ratios were 1.07 warm, 0.95 cold, 0.90 burst-3, 0.95 burst-5, 0.37 burst-20, and 2.56 multi-project. The two registered burst ratios moved opposite the prediction. Fake→Host total median/p95 was 56/58→66/70ms warm, 135/140→137/138ms burst-5, and 421/1283→399/445ms burst-20. Host terminal-work p95 was only 9/18/23ms for those scenarios. | All 216 sessions preserved exact monotonic stages, projection, two scans per project, bound four, Git cleanup, and fake/real boundary identity. All 36 equally prepared Hosts passed health, exact expected empty/live inventory, PTY close, shutdown, stderr, and root-removal gates. | Keep the paired diagnostic and artifact; reject active PTY overlap as the cause of the provider tail. No production change. | Can a right-sized five-slot pool retain the decisive no-mutation win without EXP-014's 20-registration startup and replenishment overhead? |
| BENCH-018-P | A pool sized to the five-session product burst budget can retain pooled activation's common-path win while avoiding EXP-014's 20-registration fill and discovery cost; sessions beyond five can safely fall back to native creation. | Parameterized the paired pool diagnostic at five slots; singles/3/5 activate slots, while burst-20 interleaves five activations with 15 retained native fallbacks and records fifth/final completion. | BENCH-012-W pool-20 filled at 176/272ms median/p95; EXP-014 fill reached 365/425ms. Five-slot advancement required fill p95 ≤150ms; ≥25% single and ≥30% burst-5 median/p95 wins; ≥30% burst-20 fifth-session median/p95 win; and no more than 20% final burst-20 regression. | Rejected. Fill median/p95 was 58/126ms. Native→pooled single improved 124/220→36/118ms (71%/47%) and burst-5 136/389→71/73ms (48%/81%). Burst-20 fifth median improved 178→97ms (46%) and final median 482→422ms (12%), but one hybrid-tail repetition made fifth p95 regress 228→587ms and final p95 regress 511→1398ms. | All 290 guarded operations passed. Every run used exactly five activations and, for burst-20, 15 native fallbacks; identity, unique paths/branches, bound four, expected hybrid inventory, slot reset, fallback removal, cleanup to 54, and all five root removals were exact. | Keep the parameterized diagnostic and artifact; reject the interleaved five-slot hybrid and do not advance a production pool. | Does separating the activation wave from all native fallbacks eliminate mixed Git pressure while preserving first-five latency? |
| BENCH-019-W | The five-slot burst-20 tail comes from overlapping `git switch` activation with native `git worktree add` fallback; completing the activation wave before admitting fallbacks will stabilize the first five without materially delaying the final 15. | Added an opt-in phased fallback policy: all five activations settle under bound four before any of 15 native fallbacks starts; native control and other scenarios remain unchanged. | BENCH-018-P burst-20 native fifth/final median/p95 was 178/228ms and 482/511ms; interleaved hybrid was 97/587ms and 422/1398ms. Phased required fifth ≤125/160ms, final ≤578/614ms, fill ≤150ms, and retained common-path gates. | Rejected. Fill p95 was 74ms; single and burst-5 improved 39%/40% and 45%/46% median/p95. Phased burst-20 ordinary runs clustered at 61–64ms for the fifth completion and 326–329ms final, with medians 63/327ms, but one isolated activation stall reached 467ms before fallback admission and final 1359ms. P95 failed 160/614ms; native p95 in the paired window was 349/913ms fifth/final. | Every fallback started strictly after all five activations completed. All 290 operations, five-activation/15-fallback counts, bound four, identities, inventories, slot resets, fallback/branch removals, cleanup to 54, and five root removals passed. | Keep the diagnostic and artifact; reject phase separation and do not advance or retry the pool family. | In hooks-disabled projects, does removal still pay Worktrunk orchestration that native creation already proved unnecessary? |
| BENCH-020-RM | Hooks-disabled managed removal still pays Worktrunk list/remove orchestration even though EXP-010 proved native Git sufficient for creation; strict native revalidation plus removal may shorten cleanup bursts and avoid the historical five-second timeout. | Compared alternating Worktrunk and native-Git removals for 1/3/5/20 worktrees on five fresh 49-worktree repositories under bound four. Recreated the exact burst before each strategy and required cleanup before continuing. | Historical concurrent `worktree.remove` exceeded Worktrunk's 5s process timeout. Advance a production candidate only if native removal improves single median/p95 ≥25%, burst-5 and burst-20 median/p95 ≥40%, and every safety gate passes. Prediction: native improves burst-5/20 by at least 60% because it replaces enriched Worktrunk list/remove with strict Git structural evidence and direct removal. | Native Git improved single median/p95 543/619→64/356ms (−88%/−42%), burst-5 1400/1468→165/953ms (−88%/−35%), and burst-20 4912/7207→465/624ms (−91%/−91%). Burst-3 improved 775/841→83/180ms. The burst-5 p95 improvement missed the registered 40% gate despite the large median win. | All 290 removals passed exact pre-removal path/branch/administrative identity, unique inventory, no-primary, bound-four, exact absence, unique-branch deletion, cleanup-to-49, redaction, and five-root removal checks. Two burst-5 native samples stalled together to 788/953ms under high host load; the valid matrix is retained without retry. | Reject mechanically; do not add a production native-removal path. | Can removal latency be removed from session-start completion entirely by proving cleanup is an independently durable follow-up responsibility? |
| BENCH-021-B | The retained hooks-disabled create path launches one identical `core.bare` Git probe per command; sharing only the currently in-flight probe can remove duplicate subprocess pressure without caching a verdict across later mutations. | Compared alternating independent-probe and in-flight-singleflight native create bursts of 1/3/5/20 on five fresh 49-worktree repositories under bound four. Both used the retained `git worktree add`, process verification, and registration proof. | EXP-010's bare-probe p95 is 11/14/14ms for warm/burst-3/burst-20 and contributes one process per create. Advance a production candidate only if burst-5 and burst-20 median/p95 improve ≥8%, single p95 regresses no more than 15%, candidate probe executions are fewer for every burst above one, no settled verdict is reused, and every safety gate passes. Prediction: removing 3 of 4 probes per admission wave improves burst-5/20 median and p95 by at least 10%. | Rejected. Probe executions fell 3→1, 5→2, and 20→5–8, but independent→singleflight median/p95 was 81/233→100/228ms for burst-3, 163/583→266/1128ms for burst-5, and 474/1722→982/1246ms for burst-20. Single p95 also regressed 244→358ms. Sharing synchronized Git adds and worsened the registered medians/tails. | All 40 strategy runs passed exact path/branch/process verification, administrative registration identity, unique inventory, bound four, cleanup to 49, redaction, and five-root removal. The deterministic check shared four simultaneous callers once and executed a new probe after settlement. | Reject mechanically; do not share the bare probe in production. | Does retained native Git perform better at a lower per-project admission bound that avoids synchronized repository-lock pressure? |
| BENCH-022-C | EXP-010 retained Worktrunk's four-wide admission after replacing its broad mutation with narrower native Git, but BENCH-021-B shows that four closely released adds can amplify repository-lock tails; a bound of three may trade one small wave for more stable completion. | Compared alternating bound-four and bound-three retained native create paths for bursts of 3/5/20 on five fresh 49-worktree repositories. Each command kept its own bare probe, native add, process verification, and registration proof. | BENCH-007-G add-only bound-four median/p95 was 93/168ms for burst-5 and 305/342ms for burst-20; current-load BENCH-021-B full-path control was 163/583ms and 474/1722ms. Advance a production candidate only if bound three improves burst-5 and burst-20 median/p95 ≥10%, burst-3 p95 regresses no more than 10%, and every safety gate passes. Prediction: bound three improves all four burst-5/20 metrics by at least 15% by reducing simultaneous Git lock pressure. | Rejected. Bound four→three median/p95 was 66/362→65/179ms for burst-3, 134/141→125/167ms for burst-5, and 405/829→480/494ms for burst-20. Bound three stabilized large-burst p95 by 40%, but burst-20 median regressed 18% and burst-5 p95 regressed 19%; the registered all-metric rule failed. | All 30 runs passed exact path/branch/process verification, registration identity, unique inventory, expected peak three/four, cleanup to 49, alternating order, redaction, and five-root removal. Bound-three burst-20 mutation p95 was 51ms versus bound-four 122ms, confirming a real pressure/tail tradeoff. | Reject global bound three; retain four. | Can four-wide admission for product-sized bursts transition to three-wide steady pressure only for overflow, preserving the median while reducing burst-20 tail? |
| BENCH-023-A | Bound three stabilizes large-burst Git tails but loses median throughput; admitting the first four together and limiting only subsequent overflow to three active adds may retain the four-wide common path while avoiding sustained lock pressure. | Extended the retained add-only concurrency diagnostic with an alternating overflow-adaptive candidate. Bursts ≤5 remained exactly four-wide; burst-20 started four, then never exceeded three active adds after the first completion. | BENCH-022-C full-path bound-four→three burst-20 was 405/829→480/494ms; add mutation p95 improved 122→51ms. Advance only if adaptive burst-20 p95 improves ≥25%, median regresses ≤10%, burst-3/5 median and p95 regress ≤10%, exact transition is observed, and all safety gates pass. Prediction: adaptive p95 improves at least 30% with no more than 5% median regression. | Rejected. Bound-four→adaptive median/p95 was 83/743→73/160ms for burst-3, 153/198→124/598ms for burst-5, and 264/382→306/425ms for burst-20. The registered burst-20 candidate regressed median 16% and p95 11%; an otherwise identical four-wide burst-5 candidate also hit a 598ms host outlier. | Every 20-item candidate began at peak four and transitioned to a post-first-completion peak of exactly three. All 30 runs passed exact branch/path inventory, unique registrations, cleanup to 49, alternating order, resource/load capture, and root removal. | Reject adaptive overflow and end the admission-bound family; retain four. | Can starting Station Host concurrently with ordinary Observer startup remove its cold on-demand cost without delaying Observer readiness? |
| BENCH-024-H | Host-backed Station launch pays Host ensure/start only after Quick Session intent, even though Observer startup already spends roughly 190–268ms on its initial 49-worktree scan; starting Host ensure concurrently may make terminal readiness warm by the time commands are accepted. | Alternated on-demand and prewarm-before-scan Bun Host lifecycles on five repetitions of one real shaped repository. Each strategy ran the same Worktrunk startup read, then measured intent through spawn, attach, ready, controller input, and child acknowledgement. | BENCH-015-T Bun cold Host-start p95 was 521ms while warmed intent-to-ack p95 was 6ms. Advance a production candidate only if prewarm improves cold intent-to-ack median/p95 ≥60%, Worktrunk startup-scan median/p95 regress ≤10%, prewarm is non-blocking and shares one exact ensure result, and every Host/PTTY/inventory/cleanup gate passes. Prediction: the 49-worktree scan hides enough Host startup for intent-to-ack p95 ≤100ms without scan regression. | Rejected. On-demand→prewarmed intent-to-ack median/p95 was 597/1946→367/2150ms: median improved 38%, below 60%, while p95 regressed 10%. Candidate startup scan median changed 279→281ms (+1.0%) and p95 improved 926→341ms, so the failure was residual Host startup, not shifted scan work. No candidate ensure settled before immediate post-read intent; ensure median/p95 was 635/2414ms. | All ten Hosts passed exact 49-worktree discovery, compatible health, one ensure/spawn, immutable PTY identity, readiness and controller acknowledgement, exact live/empty inventory, clean stop, empty stderr, alternating order, and Host/repository root removal. | Reject prewarm-only production change; do not move cold work behind readiness. | Can a prebuilt Host entry reduce source-mode executable startup enough to make cold launch itself fast? |
| BENCH-025-E | Checkout mode asks Bun to load the Host TypeScript module graph for every cold Host, while the installed Station binary dispatches an already-compiled `__station-host`; a prebuilt Host bundle may isolate and remove source-loader startup cost. | Compared alternating source-entry and prebuilt-bundle Host lifecycles across five repetitions. Built the candidate once outside measured startup, then measured ensure through real Bun PTY readiness and controller input acknowledgement. | BENCH-024-H on-demand cold intent-to-ack median/p95 was 597/1946ms and ensure median/p95 was 585/1933ms. Advance a production candidate only if the bundle improves cold intent-to-ack median/p95 ≥30%, candidate p95 is ≤500ms, bundle construction succeeds without runtime externals, and every Host/PTTY/identity/inventory/stop/cleanup gate passes. Prediction: one bundle cuts median and p95 by at least 40% because it avoids resolving the source module graph at launch. | Passed. Source→bundle intent-to-ack median/p95 was 186/412→122/225ms (−35%/−45%); ensure was 165/262→110/112ms. The one-time bundle took 83ms, was 1.79MB, and retained no non-platform runtime imports. | All ten Hosts passed compatible health, one spawn, immutable PTY identity, content-free readiness/input acknowledgement, exact live/empty inventories, clean stop, empty stderr, alternating order, and Host/bundle-root removal. An initial fixture-only run stopped before candidate timing because bundled `import.meta.url` moved the helper; the corrected layout produced the registered matrix. | Keep the diagnostic and executable-entry hypothesis. Do not add a second source packaging path before measuring the already-shipped compiled `__station-host`. | Does installed compiled self-dispatch achieve the same cold-start win while materializing its packaged PTY helper? |
| BENCH-026-I | The installed Station binary already dispatches Host startup from one compiled executable, so it may realize BENCH-025-E's loader win without adding a separate source bundle or duplicated packaging path. | Built the current checkout binary once outside timing, then compared alternating source-entry and compiled `__station-host` lifecycles across five repetitions with fresh state and real Bun PTYs. | BENCH-025-E source→bundle intent-to-ack median/p95 was 186/412→122/225ms; bundle ensure was 110/112ms. Retain the existing compiled boundary as sufficient only if compiled improves source median/p95 ≥30%, compiled p95 is ≤500ms even while materializing its packaged helper into fresh state, and every Host/PTTY/identity/inventory/stop/cleanup gate passes. Prediction: compiled improves both metrics at least 35% and stays below 300ms p95. | Rejected. Source→compiled intent-to-ack median/p95 was 804/2311→475/1343ms (−41%/−42%), but compiled missed the absolute 500ms tail gate. Compiled ensure itself was 378/1280ms; post-ensure interaction was 23/97ms. | All ten Hosts passed current identity, compatible health, one spawn, immutable PTY identity, readiness/input acknowledgement, exact live/empty inventories, clean stop, empty stderr, alternating order, and root removal. The valid run included packaged-helper extraction in every compiled sample. | Keep the product-path evidence but reject the existing compiled boundary as sufficient for cold-start latency. | How much of compiled ensure is packaged helper materialization versus executable startup? |
| BENCH-027-C | Fresh compiled Host state extracts, validates, probes, and leases the embedded controlling-terminal helper before opening its socket; that packaged-asset path may dominate BENCH-026-I's 378/1280ms ensure distribution. | Compared alternating compiled `bun` and compiled `bun-nocctty` Host lifecycles on five fresh state roots. Both used the same 78MB binary and real Bun terminal transport; only packaged-helper preparation was omitted in the diagnostic arm. | BENCH-026-I compiled intent-to-ack median/p95 was 475/1343ms and ensure was 378/1280ms. Treat helper preparation as the next production target only if no-ctty improves intent-to-ack and ensure median/p95 ≥25%, all exact interaction gates pass, and temporary state is removed. Prediction: skipping fresh helper preparation improves both ensure metrics at least 30%. | Rejected as the tail target. Packaged→no-ctty intent median/p95 was 337/1344→171/1132ms (−49%/−16%); ensure was 321/1327→163/1090ms (−49%/−18%). Median gates passed, but both tail gates missed 25%. | All ten runs used the same current binary and passed health, one spawn, immutable PTY identity, readiness/input acknowledgement, exact live/empty inventories, clean stop, empty stderr, alternating order, and root removal. No-ctty remains attribution-only. | Do not remove controlling-terminal correctness or optimize helper setup as the next tail fix. | Does the existing `host.start` log place the residual no-ctty tail before Host initialization or between initialization and polled health? |
| BENCH-028-M | The no-ctty p95 still exceeds one second, so the tail either occurs while the 78MB executable reaches `host.start` or after initialization while the controller polls health every 50ms. Existing Host logs can split those phases without production instrumentation. | Recorded intent wall time beside monotonic time, parsed the strict `host.start` record before root removal, and ran five compiled no-ctty lifecycles with the same full PTY interaction proof. | BENCH-027-C no-ctty ensure median/p95 was 163/1090ms. Attribute the next target to executable/pre-start work if intent-to-`host.start` accounts for ≥75% of ensure p95; attribute it to post-start/socket/polling only if that phase is ≥50% of ensure p95. Prediction: pre-start accounts for at least 85% of the tail, because polling contributes at most one 50ms interval. | Passed and attributed pre-start. Ensure median/p95 was 161/1013ms; intent-to-`host.start` was 133/993ms (98% of ensure p95), while post-start through polled health was 29/88ms p95. | All five strict log parses, phase sums, 25ms clock-coherence checks, current binary identity, Host/PTTY/input/inventory/stop/stderr, and root removals passed. | Keep the milestone diagnostic; do not prioritize polling. | Can a dedicated Host-only compiled executable avoid the monolithic Station binary's pre-start tail? |
| BENCH-029-D | The compiled all-in-one Station binary is 78MB and spends 98% of tail ensure before Host initialization; a Host-only compiled executable may load materially less application code and avoid that tail. | Compiled a dedicated `hostMain.ts` executable once outside timing with the current version/identity, then compared alternating monolithic and dedicated no-ctty Host lifecycles on five fresh roots. | BENCH-028-M monolithic no-ctty ensure median/p95 was 161/1013ms and pre-start p95 was 993ms. Advance a packaging candidate only if dedicated intent-to-ack and ensure median/p95 improve ≥30%, dedicated p95 is ≤500ms, its file is smaller, and every exact Host/PTTY/log/cleanup gate passes. Prediction: dedicated improves p95 at least 50% and remains below 300ms. | Rejected. The 60MB dedicated binary improved median intent 181→125ms (31%) and ensure 166→111ms (33%), but p95 worsened 1028→1175ms and 1014→1124ms. Both binaries' first measured launch supplied the ~1s tail; later samples clustered at 108–237ms ensure. | All ten current-identity, strict milestone, health, spawn, PTY identity/input, inventory, stop, stderr, alternating-order, candidate removal, and Host-root gates passed. | Do not add a second executable; binary size did not remove the tail. | Is the ~1s sample a one-time newly-built executable warmup rather than the steady cold-Host distribution after Station is already running? |
| BENCH-030-S | Five-sample p95 equals the maximum, and BENCH-028/029 place the single ~1s outlier at the first launch of each newly built executable; a longer sequence can distinguish first-execution warmup from steady cold-Host startup. | Built once, then ran 20 sequential compiled no-ctty Host lifecycles on fresh state while retaining per-position milestones and interaction gates. Reported full and positions 2–20 distributions separately. | BENCH-029-D monolithic ensure samples were 1014, 223, 166, 161, 162ms by position; intent samples were 1028, 239, 181, 169, 171ms. Treat first-execution warmup as non-steady only if positions 2–20 intent and ensure p95 are ≤300ms, at least 80% of samples above 500ms occur in positions 1–2, and all 20 runs are exact. Prediction: the first sample is the only sample above 500ms and steady p95 is ≤250ms. | Rejected. Positions 2–20 intent/ensure p95 were 711/670ms. Slow ensures >500ms occurred at positions 1, 8, 9, 13, and 14, so only 20% were early. Full median remained 174/164ms, but periodic pre-start scheduling produced the tail. | All 20 current-identity, position, strict milestone, health, spawn, PTY/input, inventory, stop, stderr, and fresh-root gates passed. Load average was 29–31 throughout; slow samples remained mostly pre-`host.start`. | Do not discard first samples or relabel the tail as warmup. | Can compiled Host prewarm overlap this externally scheduled process start with real startup discovery without delaying Observer readiness? |
| BENCH-031-H | Source-mode prewarm failed because Host ensure exceeded the startup scan, but compiled typical ensure is ~164–321ms against a ~279ms 49-worktree scan; the installed Host may often become healthy before immediate post-scan intent. | Extended the real prewarm matrix with an opt-in current compiled `__station-host` command, preserving alternating on-demand/prewarm order, fresh state, packaged Bun PTY, and the same real Worktrunk startup scan. | BENCH-024-H source on-demand→prewarm intent median/p95 was 597/1946→367/2150ms with zero early settles. BENCH-026/027 compiled ensure medians were 321–378ms with packaged helper. Advance only if compiled prewarm improves intent median/p95 ≥50%, candidate p95 is ≤300ms, scan median/p95 regress ≤10%, at least four of five candidates settle before intent, and every exact gate passes. Prediction: four candidates settle before intent and p95 improves at least 60%. | Rejected. On-demand→prewarm intent median/p95 was 330/1402→234/249ms (−29%/−82%). No candidate fully settled before intent. Startup-scan median improved 250→213ms, but p95 regressed 326→1043ms when Host and Worktrunk stalled together. | All ten current compiled identity, one-ensure/spawn, exact 49-worktree, immutable PTY/input, live/empty inventory, stop, stderr, alternating-order, and Host/repository-root gates passed. | Do not shift compiled Host contention into fresh startup. | Does restart-persistent cached Host state make nonblocking prewarm complete within discovery without scan contention? |
| BENCH-032-R | BENCH-031-H modeled first-ever fresh state, but the completion criterion is an ordinary Observer restart: packaged assets and executable pages persist from prior Host use and should shorten a replacement Host enough for discovery to hide it. | Before each measured compiled strategy, start and safely stop one idle Host in the same state root, then run the unchanged alternating on-demand/prewarm Worktrunk matrix. Seed work is setup evidence and every measured Host is still a new process. | BENCH-031-H fresh-state prewarm intent median/p95 was 234/249ms, scan p95 regressed 220%, and zero ensures settled early. Advance only if restart-shaped prewarm improves intent median/p95 ≥50%, candidate p95 is ≤100ms, scan median/p95 regress ≤10%, at least four candidates settle before intent, and all seed/measured safety gates pass. Prediction: cached-state prewarm settles all five and yields intent p95 ≤50ms. | Rejected by its preregistered early-settle rule. On-demand→prewarm intent median/p95 was 171/171→16/68ms (−91%/−61%); scan median/p95 was 241/263→214/265ms, within the 10% guardrail. Every prewarm ensure nevertheless settled 1–68ms after intent, so zero of five met the required before-intent boundary. | All ten exact idle seeds, current identity, one measured ensure, 49-worktree inventory, PTY identity/input, live/empty Host inventory, stop, stderr, alternating order, and repository/Host-root removals passed. | Do not weaken the gate retroactively; the simulated scan-start overlap is insufficient by itself. | Does actual Observer provider composition supply enough pre-scan runway for the same cached Host ensure to settle before readiness? |
| BENCH-033-G | The real Observer performs provider composition before SQLite setup, runtime assembly, socket/pidfile publication, and startup reconciliation, so beginning the same cached Host ensure at provider construction may finish before readiness without delaying or contending with its 49-worktree scan. | Run alternating on-demand and provider-composition-prewarm starts through `runObserverMain`; both use current compiled Host state seeded by one exact idle lifecycle, the same real Worktrunk project, and the same post-ready PTY interaction. | BENCH-032-R prewarm intent median/p95 was 16/68ms but every ensure settled 1–68ms after scan-complete intent. Advance only if composition prewarm improves post-ready intent median/p95 ≥50%, candidate p95 is ≤100ms, Observer readiness and startup-scan median/p95 each regress ≤10%, at least four of five ensures settle before readiness, and all Observer/Host safety gates pass. Prediction: all five ensures settle before readiness and post-ready p95 is ≤50ms. | Rejected. On-demand→composition-prewarm intent median/p95 was 594/900→180/924ms: median improved 70%, but p95 regressed 3% and exceeded 100ms. Four of five Hosts settled before readiness. Candidate scan and Observer-startup p95 improved 67%/66% in this paired window, so shifted startup was not the failure. | All ten exact seeds, current identity, single measured ensure/spawn, healthy ready Observers with 49 worktrees and one pre-ready startup scan, PTY identity/input, inventories, clean Observer/Host stops, stderr, alternating order, and state/repository-root removals passed. | Do not add provider-composition prewarm; readiness overlap did not bound post-ready PTY interaction. | Does an already-running, previously PTY-used Host surviving the Observer restart bound the actual ordinary-restart path? |
| BENCH-034-L | An ordinary Observer restart should reuse the external Host process rather than replace it; if that Host has already completed one exact PTY lifecycle, both executable and PTY-runtime cold work are outside the restart and the first post-ready session should stay below 100ms. | Before measured startup, both arms start the current compiled Host and complete one exact spawn/attach/input/close warmup to empty inventory. The control then stops it and launches a replacement after readiness; the candidate leaves it healthy through the real Observer restart and reuses it after readiness. | BENCH-033-G composition prewarm settled 4/5 Hosts before readiness but candidate intent median/p95 was 180/924ms. Advance only if preserved-live-Host intent median/p95 improve ≥75%, candidate p95 is ≤100ms, measured ensure p95 is ≤25ms, Observer readiness and startup-scan median/p95 regress ≤10%, all five candidates are healthy before Observer startup, and every exact gate passes. Prediction: candidate p95 is ≤50ms and measured ensure p95 is ≤10ms. | Rejected. Replacement→preserved intent median/p95 was 341/515→169/604ms: median improved 50%, but p95 regressed 17%. Preserved measured ensure median/p95 was 4.9/31.7ms, narrowly missing 25ms. Candidate scan and Observer-startup medians improved 11%/10%, but one 978/1315ms outlier regressed both p95s by more than 250%. | All five candidates were healthy with empty inventory before Observer startup. All ten warmup/measured PTY identities and input acknowledgements, expected one/two total spawns, single measured ensure, ready 49-worktree snapshot, one pre-ready scan, empty inventory, Observer/Host stops, stderr, alternating order, and root removals passed. | Process survival is valid but insufficient; do not treat it as a bounded interactive path. | Which post-ready Host/PTTY phase owns the residual preserved-Host tail? |
| BENCH-035-P | BENCH-034-L reduced measured Host ensure to 4.9ms median but left 151–604ms intent samples, so strict phase timestamps should identify whether Host spawn RPC, attach/replay, child readiness, or controller input acknowledgement owns the residual tail. | Run ten preserved-live-Host Observer restarts with the identical setup and safety matrix, recording intent→ensure, ensure→health, health→spawn response, spawn→attach, attach→ready marker, and ready→input acknowledgement. No phase is removed or reordered. | BENCH-034-L preserved intent median/p95 was 169/604ms and ensure was 4.9/31.7ms. Attribute a next target only if every phase is nonnegative, phase sums match intent within 10ms, all ten runs are safe, and one phase supplies ≥60% of total p95 plus ≥50% of at least two samples over 100ms. Prediction: health→spawn response supplies ≥75% of p95. | Attribution passed, prediction disproved. Intent median/p95 was 153/279ms. Intent→ensure-settle supplied 269ms, 96% of total p95, and at least half of all ten >100ms samples; ensure itself was only 3.0/7.8ms. All later phase p95s were at most 5.0ms. | All ten phase sums were exact, nonnegative, and safe. Current live Host, warmup/measured identity/input, ready 49-worktree Observer, one startup scan, inventories, stops, stderr, and roots passed. | Keep the diagnostic; do not target Host spawn, attach, child readiness, or input. | Is the pre-ensure gap an in-process benchmark artifact from Observer post-ready duplicate inspection that disappears across the real process boundary? |
| BENCH-036-X | `runObserverMain` signals ready and then synchronously begins duplicate-process inspection; BENCH-035-P runs Observer and caller in one event loop, while production uses a separate Observer process, so the 145–269ms pre-ensure gap should disappear across the compiled process boundary. | Ran ten compiled Observer child processes with the same live PTY-used Host and real 49-worktree config. The parent accepted intent on the first healthy startup response, immediately performed measured ensure and PTY interaction, and recorded readiness→ensure-start separately from ensure and later phases. | BENCH-035-P intent median/p95 was 153/279ms; readiness→ensure-settle p95 was 269ms while ensure p95 was 7.8ms and every later phase p95 was ≤5ms. Keep cross-process evidence only if intent median/p95 are ≤50/100ms, readiness→ensure-start p95 is ≤10ms, ensure p95 is ≤25ms, Observer startup p95 is ≤1500ms, and all ten exact gates pass. Prediction: intent p95 is ≤50ms and readiness→ensure-start p95 is ≤2ms. | Rejected only by the independent startup-tail guard. Cross-process intent median/p95 was 12.5/40.6ms; readiness→ensure-start was 0.004/0.020ms and ensure was 2.0/4.5ms, so every interactive threshold and both predictions passed. Observer startup median/p95 was 814/1853ms, with four samples above 1500ms, failing its fixed gate. | All ten exact compiled child identities, healthy startup responses, 49-worktree snapshots, live PTY-used Hosts, measured immutable PTY identities and input acknowledgements, empty inventories, protocol stops, zero exits, empty stderr, timing sums, and root removals passed. | Keep the process-boundary diagnosis; reject the overall candidate mechanically and do not weaken the startup gate. The BENCH-035 pre-call tail was an in-process harness artifact. | Can the full compiled CLI Quick Session path retain the validated post-ready bound through its command and TUI layers while separately exposing Observer startup? |
| BENCH-037-U | The compiled CLI launcher, native dashboard input/state transition, Observer command transport, and native managed-launch composition should add no more than 60ms p95 beyond the retained real Worktrunk plus warmed-Host path, while ordinary auto-start remains visible as a separate cost. | Ran five current compiled CLI launches against one exact 49-worktree repository. Before each run, preserved a current PTY-used empty Host, stopped Observer, launched bare `stn` through a real PTY, opened the project view when first-run UI required it, activated Quick Session, then timed optimistic UI, command/trace, Host readiness, canonical UI, queued-pane focus, and input acknowledgement. | BENCH-017-A's same-window real-terminal warm single was 66/70ms median/p95; BENCH-036-X's post-ready PTY interaction was 12.5/40.6ms and compiled Observer startup was 814/1853ms. Keep only if CLI launch→dashboard median/p95 are ≤1500/2500ms, intent→optimistic p95 ≤50ms, intent→interactive median/p95 ≤100/200ms, intent→canonical UI p95 ≤350ms, full launch→interactive p95 ≤2700ms, and all five exact gates pass. Prediction: intent→interactive p95 ≤125ms and launch→dashboard p95 ≤2200ms. | Rejected. CLI launch→dashboard was 1900/2091ms, so median failed while p95 and the 2200ms prediction passed. Intent→optimistic was 9.6/10.3ms, command completion 82.6/93.1ms, Host ready 127.5/255.4ms, and canonical UI 168.0/282.9ms. Intent→focused input acknowledgement was 715/819ms and full launch→interactive 2701/2903ms, failing both registered outcome bounds. | All five current identities, 49-worktree starts, unique command/trace/worktree/session/PTTY identities, configured scripted harness and Station terminal binding, ready/input markers, canonical convergence, actual focus/input, cleanup to 49, process stops, Host stderr, and root removals passed. The literal empty-UI-stderr rule failed only on the expected `Launching STATION TUI…` progress line in every run. | Reject mechanically. Keep the diagnostic; do not hide the focus delay or reinterpret intentional progress as empty stderr. | Does the ~540–570ms canonical-to-input gap come from raw Escape disambiguation, and does the existing unambiguous Ctrl-O overlay toggle remove it? |
| BENCH-038-F | BENCH-037-U sends raw Escape to dismiss the dashboard after the created pane is queued; terminal input must delay lone Escape to distinguish it from a sequence, while Ctrl-O is an unambiguous existing overlay toggle and should focus the same pane immediately. | Alternated five Escape and five Ctrl-O focus gestures across otherwise identical compiled CLI/native Quick Session runs, adding timestamps for focus gesture→overlay dismissal and dismissal→input acknowledgement. No Quick Session, Observer, Host, or focus semantics changed. | BENCH-037-U intent→canonical UI median/p95 was 168/283ms but intent→interactive was 715/819ms, leaving 536ms at the p95 focus/input boundary. Attribute and advance only if Ctrl-O focus→ack p95 is ≤100ms and improves ≥75% over same-window Escape, Ctrl-O intent→interactive median/p95 are ≤250/350ms, all phase sums are coherent, and all ten exact gates pass. Prediction: Ctrl-O focus→ack p95 ≤50ms and intent→interactive p95 ≤300ms. | Rejected. Escape→Ctrl-O focus-to-ack median/p95 was 542/600→33/165ms and intent-to-interactive was 794/846→213/634ms. Ctrl-O overlay dismissal itself was 21/24ms, but one 148ms post-write acknowledgement outlier made focus-to-ack p95 miss 100ms, same-window p95 improvement reach only 72.6%, and intent p95 miss 350ms. | All ten phase sums were coherent and every run reached exact ready/input, canonical UI, cleanup, and process-stop milestones. The aggregate exact-safety assertion failed: one run emitted an additional expected Observer-start progress line, and the report did not retain named boundary predicates needed to explain why the other nine rows also recorded `safe=false`. | Reject mechanically; retain the Escape attribution but do not advance an automatic dashboard dismissal from this result. | Which collapsed boundary predicate made all rows unsafe, and does a named safety audit confirm the semantic path independently of the timing reject? |
| BENCH-039-S | BENCH-038-F collapsed every product-boundary invariant into one `safe` boolean, preventing the retained artifact from distinguishing a semantic mismatch from a faulty benchmark expectation. | Added named booleans for every existing BENCH-038 boundary predicate and ran one Ctrl-O product-boundary repetition; made no production or timing-path change. | BENCH-038-F reached every awaited milestone and exact cleanup but recorded ten unsafe rows. Accept the audit only if every semantic, identity, input, inventory, and process predicate is named, exactly one false predicate explains each unsafe result, and the root is removed. Prediction: the false predicate is a benchmark expectation rather than session identity, input, or cleanup. | Accepted. Exactly one predicate was false: the test expected canonical terminal provider `station`, while the provider-neutral Station Host ID is `native`. The run reached canonical UI in 314ms, focus-to-ack in 97ms, and intent-to-interactive in 410ms; these are diagnostic context, not a latency claim. | All other 18 named predicates passed, including exact command, worktree/registration, scripted harness, Host worktree/session, ready/input, zero Host inventory, 49-worktree cleanup, clean stops, exact progress stderr, phase coherence, and root removal. | Keep named safety evidence and correct the benchmark expectation to `STATION_HOST_PROVIDER_ID`; BENCH-038 remains rejected. | Does automatic dashboard dismissal after canonical Quick Session success eliminate the second gesture while preserving failure and deliberate-create behavior? |
| EXP-016 | Native Quick Session already publishes a managed pane as the dashboard overlay's return target, so making only that shortcut a foreground landing and dismissing only its proven successful landing should remove the second gesture without weakening failure visibility. | Temporarily carried an explicit foreground request through native managed launch, closed the overlay only for `success` with `landed: true`, and left deliberate Create, Fork, notices, failures, and non-landing success unchanged. | BENCH-038-F Ctrl-O intent-to-interactive was 213/634ms median/p95 over five alternating control runs; BENCH-039-S was 410ms once after fixing the terminal-provider expectation. Keep only with ten safe control and ten safe candidate runs, candidate intent-to-interactive median/p95 at most 200/350ms, candidate p95 at least 25% below the fresh control, automatic overlay-dismissal-to-input-ack p95 at most 100ms, no dismissal input byte in candidate runs, and every exact identity, canonical, input, inventory, stop, stderr, phase, and root predicate true. Prediction: automatic candidate intent-to-interactive p95 is at most 300ms and at least 40% below fresh Ctrl-O control. | Rejected. Fresh Ctrl-O control was 220/2348ms median/p95; automatic dismissal was 196/358ms, improving median 11% and p95 84.8%. The candidate passed the 200ms median and relative rules but missed the 350ms absolute p95 by 7.8ms, missed the 100ms overlay-dismissal-to-input-ack p95 at 154ms, and missed its 300ms prediction by 58ms. | All ten control and ten candidate runs passed every named identity, canonical, input, inventory, stop, stderr, phase, and root predicate. Candidate runs sent no dismissal byte. Focused tests proved successful landing, non-landing success, notice, launch failure, deliberate Create, Fork, canonical continuation, and foreground/background propagation; Station typecheck passed. | Revert completely under the preregistered rule; retain the runner and raw control/candidate evidence only on the continuation archive. | Can native managed launch expose bounded child-input readiness so automatic dismissal occurs only when the pane can immediately acknowledge input? |
| BENCH-040-I | EXP-016's runner waited for the scripted harness-ready marker before writing input, although automatic dismissal had already focused a Host-backed PTY that should accept and buffer controller input immediately. | Diagnostic only: reuse the exact rejected candidate binary and send the input token within 10ms of automatic overlay dismissal, then observe the independent ready marker and exact acknowledgement without rebuilding or changing production source. | EXP-016 automatic candidate was 196/358ms median/p95 intent-to-interactive and 24/154ms dismissal-to-ack. Its sole tail waited 100ms after dismissal for Host ready, then 54ms after write. Accept only if ten safe runs all write within 10ms of dismissal, at least one write precedes harness readiness by at least 25ms, every token is acknowledged exactly once, intent-to-interactive median/p95 are at most 200/320ms, p95 improves at least 10% over 358ms, dismissal-to-ack p95 is at most 120ms, and every EXP-016 identity, canonical, inventory, stop, stderr, phase, and root predicate passes. Prediction: at least one pre-ready write is retained without loss and intent-to-interactive p95 is at most 310ms. | Rejected. Immediate input produced 184/349ms intent-to-interactive: median passed, but p95 missed 320ms by 29ms, improved only 2.4% rather than 10%, and missed the 310ms prediction. Dismissal-to-ack passed narrowly at 24/118ms. | All ten runs passed every named safety predicate, wrote within 0.064ms of dismissal, and acknowledged the exact token once. One live-observed run safely wrote 115ms before Host readiness; no candidate sent a dismissal byte. | Retain the buffer-safety attribution, but reject the diagnostic mechanically and do not retroactively accept EXP-016. The remaining 349ms tail accumulated before automatic focus. | Which successful managed-launch phase between command completion and foreground pane focus owns the remaining tail? |
| BENCH-041-P | BENCH-040-I's 349ms tail completed its worktree command at 181ms but did not foreground the pane until 317ms; the native path serially waits for canonical worktree observation, Observer launch preparation/Host spawn, Host attachment resolution, pane publication, and dashboard settlement. | Diagnostic only: rebuild the exact reverted EXP-016 foreground/automatic-dismissal behavior with monotonic in-memory markers at each successful phase, emit the marker array only at UI process exit, and run twenty immediate-input product repetitions. | Attribute only if every run is safe; every required marker occurs exactly once and monotonically; phase sums are exact; at least two command-completion-to-focus intervals exceed 75ms; and one named phase supplies at least 60% of total p95 plus at least 50% of each of at least two intervals over 75ms. The diagnostic user-facing p95 must remain at most 380ms and attachment-resolution p95 at most 25ms. Prediction: `prepareExternalLaunch` supplies at least 70% of total p95 and at least half of every interval over 75ms; attachment resolution p95 is at most 10ms. | Accepted for attribution; prediction partly disproved. Command-completion-to-close was 52/81ms median/p95. `prepareExternalLaunch` was 31/60ms, supplied 73.9% of total p95, and supplied at least half of three of four intervals over 75ms. Attachment resolution was 13/24.982ms, passing the 25ms guard by 0.018ms but missing the predicted 10ms. User-facing p95 was 345ms. | All twenty exact traces were monotonic, phase-sum coherent, and emitted only at UI exit. Every BENCH-040 identity, immediate exact-once token, canonical, inventory, stop, stderr, and root predicate passed. | Retain the phase attribution only; revert all diagnostic and foreground behavior. The prediction failed because one tail attributed 48.4% to prepare and attachment p95 exceeded 10ms. | Which operation inside Observer `prepareExternalLaunch` owns its 60ms p95: mutation admission, Host inventory, persistence, process launch, or narrow canonical projection? |
| BENCH-042-O | BENCH-041-P attributed 60ms p95 to the client-visible `prepareExternalLaunch` RPC, but that Observer use case serially includes mutation admission, managed-target inventory, harness preflight, session persistence, managed workspace opening, launch-plan construction, Host process launch, and narrow canonical projection. | Diagnostic only: retain BENCH-041's exact product behavior and UI markers, add monotonic Observer-side marks for those subphases, write one strict artifact only when the Observer exits, and run twenty fresh immediate-input repetitions. | Attribute only if all twenty UI and Observer traces are exact, monotonic, sum-coherent, and exit-only; client RPC minus Observer internal duration has nonnegative p95 at most 15ms; at least two internal preparations exceed 40ms; and one subphase supplies at least 50% of internal p95 plus at least half of at least two over-40ms samples. User p95 must stay at most 380ms and attachment p95 at most 30ms. Prediction: Host process launch supplies at least 60% of internal p95 and at least half of every over-40ms preparation; target inventory and persistence p95 are at most 10ms each, canonical projection p95 at most 5ms, and transport residual p95 at most 10ms. | Rejected. The valid twenty-run attempt measured user intent-to-exact-input acknowledgement at 224/345ms median/p95, client-visible preparation at 33/46ms, Observer-internal preparation at 16/23ms, and client-minus-Observer residual at 18/24ms. Host process launch was the largest Observer subphase at 11/19ms and 80.9% of internal p95; target inventory, persistence, and canonical projection p95s were 4.2/1.3/1.3ms. No internal preparation exceeded 40ms, so zero required tail intervals existed, and residual p95 missed the 15ms attribution gate and 10ms prediction. | All twenty product runs and both marker layers were exact, monotonic, sum-coherent, exit-only, and safe; user p95 passed 380ms and attachment p95 was 18.7ms. Two earlier attempts were retained but invalid: the first exposed an empty-event TUI writer before Observer stop, and the second proved that reversing shutdown let that TUI writer overwrite the Observer trace. Restricting exit output to the process with recorded events corrected only the diagnostic witness. | Reject attribution mechanically and revert the temporary Observer/UI instrumentation and foreground candidate. The within-Observer Host share is descriptive only because the registered residual and tail requirements failed. | Which part of the roughly 24ms p95 client/Observer residual belongs to client request construction/serialization, socket queue/write/read, Observer request dispatch before use-case entry, and response serialization/delivery? |
| BENCH-043-T | BENCH-042-O measured 24.070ms p95 between the UI's client-visible `prepareExternalLaunch` duration and Observer use-case entry-to-return. The protocol client opens a fresh Unix socket and validates the expected Observer build with a health request before the actual launch request. | Diagnostic only: retain BENCH-042's exact behavior and traces; add exit-only client marks around runtime-boundary admission, socket connection, expected-build health validation, actual request/response, and settlement, plus Observer protocol marks around request admission, use-case dispatch, and response send. | Attribute only if twenty UI/client/server/Observer traces are exact, monotonic, exit-only, and phase-sum coherent within 0.1ms; reconstructed residual differs from client-minus-Observer residual by at most 1ms per run; at least two residuals exceed 20ms; and one named residual segment supplies at least 40% of residual p95 plus at least half of at least two over-20ms residuals. User p95 must be at most 380ms, attachment p95 at most 30ms, and residual p95 at most 35ms. Prediction: expected-build health validation supplies at least 50% of residual p95 and at least half of every over-20ms residual; socket connect, actual-request wire/client work, Observer pre-use-case dispatch, and Observer post-use-case response each have p95 at most 5ms; combined outer client settlement p95 is at most 3ms. | Rejected. All twenty exact residual decompositions had zero reconstruction error. Residual was 17.601/76.251ms median/p95 and user latency 222/853.612ms, failing the 35ms and 380ms perturbation guards. Actual-request wire/client work was largest at 9.105/48.862ms, 64.1% of residual p95, and at least half of three of nine over-20ms tails. Expected-build health was 4.180/24.603ms and only 32.3% of residual p95, disproving the prediction. | Every product predicate and all four UI/client/server/Observer trace layers passed. Attachment resolution was 11.009/18.785ms; socket connect 0.504/2.113ms; Observer pre-use-case 0.846/1.221ms; post-use-case 2.441/5.840ms; combined outer settlement 0.386/0.992ms. One prior attempt stopped after three safe runs on a blank startup frame; seven exact orphaned `st-qtu-*` TUI processes from earlier runs were identified and terminated before the authoritative attempt. Its one-minute load was 16.0–23.4 on ten logical CPUs. | Reject attribution mechanically and revert all temporary instrumentation and foreground behavior. The descriptive wire/client split cannot authorize a production optimization because both perturbation guards failed. | Under an explicit load-admission gate, does a deeper request-send/server-receive and server-send/client-receive trace reproduce actual-request wire/client dominance without violating user/residual guards? |
| BENCH-044-W | BENCH-043-T descriptively attributed 48.862ms p95 to actual-request wire/client work but failed its perturbation guards under high scheduler preemption. That remainder combines request validation/encoding/send, client-to-server scheduling, server response validation/encoding/send, server-to-client scheduling, and client response validation. | Diagnostic only: retain BENCH-043 behavior and traces; require a pre-run 50-turn event-loop and ten-spawn stability sentinel; add comparable epoch marks around request construction/send, expected-health server receipt/send, prepare server receipt/response construction/send, client response-frame receipt, and response validation. | Admit each repetition only after set-immediate p95 is at most 1ms and `/usr/bin/true` spawn p95 at most 5ms, recording every attempt and failing after 300s. Attribute only if twenty safe traces have nonnegative cross-process ordering; client, server, health, actual-request, and residual reconstruction errors are each at most 1ms; at least two actual wire/client intervals exceed 10ms; and one segment supplies at least 50% of actual wire/client p95 plus at least half of at least two over-10ms intervals. User p95 must be at most 380ms, attachment p95 at most 30ms, and total residual p95 at most 35ms. Prediction: client response-frame-to-result validation supplies at least 50% of actual wire/client p95 and at least half of every over-10ms interval; request construction/send p95 is at most 2ms; ingress and egress scheduling p95 are each at most 5ms; expected-health p95 at most 10ms; server response construction/send p95 at most 5ms. | Pending. | Pending. No sample is filtered after its product run starts. Every BENCH-043 product predicate and exit-only trace contract remains binding; no protocol validation, identity proof, timeout, connection, request, response, or launch behavior changes. | Pending; revert all diagnostic and foreground behavior regardless of outcome. | If client validation dominates, can duplicate response parsing be removed while retaining one strict boundary parse; if scheduling dominates, is a persistent multiplexed client connection a measured simplification? |

## EXP-008 preregistered change plan

Governing sources are `docs/architecture.md`, `docs/observer-architecture.md`,
`docs/architecture-documentation.md`, `docs/debugging.md`, `tests/README.md`, and
the BENCH-002-C, BENCH-003-H, BENCH-004-R, and EXP-007 evidence above. The
invariant is exact provider-returned worktree identity followed by successful
launch and eventual canonical verification; the deliberately removed behavior is
the fifth-through-eighth create waiting for a second provider-mutation wave.

Expected files are:

- production: `apps/observer/src/worktreeCreateCoordinator.ts`;
- unit coverage: `apps/observer/test/unit/worktreeCreateCoordinator.test.ts`;
- stable and real benchmarks: `tests/performance/quick-session/benchmark.test.ts`
  and `tests/performance/quick-session/observerWorktrunk.real.test.ts`;
- evidence: `tests/performance/quick-session/exp-008.synthetic.json`,
  `tests/performance/quick-session/observer-worktrunk.real.json`, and this ledger;
- architecture: `docs/observer-architecture.md` and, if generation detects a
  dependency change, `docs/generated/observer-architecture-manifest.json`.

The coordinator JSDoc was to be updated to state the eight-create default. No
connector contract or JSDoc changes are expected because provider inputs and
outputs do not change. A losing run will restore the four-create default and all
bound-specific test/documentation edits while retaining only its rejected ledger
record and raw comparison evidence.

The losing run restored the source, tests, and architecture text exactly. The
candidate raw report is `exp-008.observer-worktrunk.real.json`; the same-host
four-wide controls remain in the ignored `.dev-state/performance/quick-session/`
directory because each scenario report has the same schema as the checked full
matrix. `exp-008.synthetic.json` records why the virtual orchestration model alone
was insufficient to choose the repository-pressure bound.

## BENCH-005-P registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `tests/README.md`, and the retained
BENCH-004-R/EXP-007 provider-stage evidence. This diagnostic preserves every
provider command and merely wraps the existing injected command runner.

Expected files are
`tests/performance/quick-session/observerWorktrunk.real.test.ts`,
`tests/performance/quick-session/observer-worktrunk.real.json`, and this ledger.
No production, connector contract, architecture, or JSDoc change is expected.
The report will contain classifications and durations only—never arguments,
paths, environment, stdout, or stderr. The 10% attribution threshold in the
ledger row determines the next experiment.

## EXP-009 registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`, and
`tests/README.md`; runtime evidence is the BENCH-005-P scheduler/scan profile and
the two trace IDs in the EXP-009 row. The invariant is that a full global
reconcile never begins from create-quiescence evidence narrower than its scan
scope. Direct authoritative projection and launch remain non-blocking.

Expected files are:

- production: `apps/observer/src/worktreeCreateCoordinator.ts` and
  `apps/observer/src/runtime/api.ts`;
- unit and integration coverage:
  `apps/observer/test/unit/worktreeCreateCoordinator.test.ts` and
  `apps/observer/test/integration/external-launch-reconcile.test.ts`;
- stable/real benchmarks and evidence:
  `tests/performance/quick-session/observerWorktrunk.real.test.ts`,
  `tests/performance/quick-session/exp-009.synthetic.json`,
  `tests/performance/quick-session/observer-worktrunk.real.json`, and this ledger;
- architecture: `docs/observer-architecture.md` and, only if dependency
  generation changes, `docs/generated/observer-architecture-manifest.json`.

Coordinator JSDoc will distinguish project-local from process-global idle. The
Observer API has no exported symbol requiring new JSDoc, and no connector
contract changes. The deliberately removed behavior is scheduling a global scan
from one project's idle transition while another project is mutating.

## BENCH-006-G registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `tests/README.md`, and BENCH-002-C,
BENCH-003-H, BENCH-005-P, and EXP-009 above. This is a provider-boundary
diagnostic only; no production path changes.

Expected files are `tests/performance/quick-session/nativeGitCreateComparison.mjs`,
`tests/performance/quick-session/native-git-create-comparison.real.json`,
`tests/README.md`, `package.json`, and this ledger. No backend or connector
JSDoc, contract, architecture, or generated-manifest change is expected. The
invariants and exact 40% keep threshold are recorded in the table row; the raw
artifact will include tool versions, repository shape, alternating order,
per-command timings, load, resource use, identity checks, and cleanup counts.

## EXP-010 registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/configuration.md`, `tests/README.md`, and BENCH-006-G. The invariant is
that a successful create returns an exact path, branch, stable ID, and opaque
native registration identity for the repository named by the project. The old
behavior deliberately removed is invoking Worktrunk's broader switch workflow
when configuration explicitly disables every Worktrunk lifecycle hook.

Expected files are:

- provider source:
  `integrations/worktree/worktrunk/src/provider.ts`,
  `integrations/worktree/worktrunk/src/nativeCreate.ts`,
  `integrations/worktree/worktrunk/src/worktreeIdentity.ts`, and
  `integrations/worktree/worktrunk/src/parse.ts`;
- provider coverage: `integrations/worktree/worktrunk/test/unit/provider.test.ts`;
- persisted-default integration coverage:
  `apps/cli/test/integration/first-project-default-branch.test.ts`;
- real benchmark and evidence:
  `tests/performance/quick-session/observerWorktrunk.real.test.ts`,
  `tests/performance/quick-session/exp-010.synthetic.json`,
  `tests/performance/quick-session/observer-worktrunk.real.json`, and this ledger;
- documentation: `docs/observer-architecture.md`, `docs/configuration.md`, and
  `tests/README.md`; regenerate
  `docs/generated/observer-architecture-manifest.json` only if the dependency
  graph changes.

The `WorktrunkProvider` class JSDoc will document native no-hooks creation, and
the new native-create function will receive boundary/invariant JSDoc. No shared
contract or connector JSDoc changes are expected. A losing result restores the
Worktrunk create implementation and ID-module refactor while retaining only the
ledger and diagnostic benchmark evidence.

## BENCH-007-G registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `tests/README.md`, EXP-008, BENCH-006-G, and
EXP-010 above. This is an isolated provider-pressure diagnostic; the production
four-create coordinator remains unchanged.

Expected files are `tests/performance/quick-session/nativeGitConcurrency.mjs`,
`tests/performance/quick-session/native-git-concurrency.real.json`,
`tests/README.md`, `package.json`, and this ledger. No backend or connector
JSDoc, contract, architecture, or generated-manifest change is expected. The
paired fixture alternates bound order, records tool/machine/load/resource and
per-command timing evidence, redacts temporary paths, and removes every created
worktree and branch between candidates. Any mutation, identity, inventory,
concurrency, cleanup, or root-removal failure rejects bound eight regardless of
timing.

## EXP-011 registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, EXP-010, and BENCH-007-G above. The invariant is that native
create returns only after Station proves the exact target `.git` marker points
to an administrative directory whose `gitdir` file points back to that target
and whose symbolic `HEAD` names the requested branch. Reads must be bounded and
fail closed on malformed, missing, non-regular, or concurrently replaced files.

Expected files are:

- provider source and coverage:
  `integrations/worktree/worktrunk/src/nativeCreate.ts` and
  `integrations/worktree/worktrunk/test/unit/provider.test.ts`;
- real/stable benchmark and evidence:
  `tests/performance/quick-session/observerWorktrunk.real.test.ts`,
  `tests/performance/quick-session/exp-011.synthetic.json`,
  `tests/performance/quick-session/exp-011.observer-worktrunk.real.json`,
  `tests/performance/quick-session/observer-worktrunk.real.json`, and this ledger;
- behavior documentation: `docs/observer-architecture.md` and, only if the
  dependency generator changes, `docs/generated/observer-architecture-manifest.json`.

The native-create function JSDoc will change from command verification to
registration-file verification. No shared contract, connector JSDoc,
configuration, or composition change is expected. A losing result restores the
`rev-parse` verifier and its tests while retaining only the rejected ledger row
and raw candidate evidence.

## EXP-012 registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, EXP-009, EXP-010, and EXP-011 above. The safety invariant is
that sharing ends when the exact in-flight probe settles: no successful,
negative, failed, or timed-out result survives for a later create wave. Full
list/remove/doctor checks remain independent because their freshness and signal
policies differ.

Expected files are:

- provider source and coverage:
  `integrations/worktree/worktrunk/src/provider.ts` and
  `integrations/worktree/worktrunk/test/unit/provider.test.ts`;
- real/stable benchmark and evidence:
  `tests/performance/quick-session/observerWorktrunk.real.test.ts`,
  `tests/performance/quick-session/exp-012.synthetic.json`,
  `tests/performance/quick-session/exp-012.observer-worktrunk.real.json`,
  `tests/performance/quick-session/observer-worktrunk.real.json`, and this ledger;
- architecture behavior: `docs/observer-architecture.md` and, only if dependency
  generation changes, `docs/generated/observer-architecture-manifest.json`.

The `WorktrunkProvider` class JSDoc and the new create-guard helper JSDoc will
state the in-flight-only lifetime. No shared contract, connector JSDoc,
configuration, command composition, or generated dependency change is expected.
A losing result restores independent create probes while retaining the rejected
ledger row and raw candidate artifacts.

## BENCH-008-L registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `tests/README.md`, BENCH-004-R, EXP-010, and
EXP-012 above. This is a read-only provider-boundary diagnostic. It does not
change Observer startup, provider contracts, or the Worktrunk adapter.

Expected files are `tests/performance/quick-session/nativeGitListComparison.mjs`,
`tests/performance/quick-session/native-git-list-comparison.real.json`,
`tests/README.md`, `package.json`, and this ledger. No backend or connector
JSDoc, contract, architecture, or generated-manifest change is expected. The
strict native parser recognizes only Git porcelain fields and fails on malformed
or duplicate structural evidence. The report records machine/tool versions,
alternating order, durations, load/resource deltas, normalized structural
inventories, safe cleanup, and no raw temporary paths. Worktrunk-only dirty and
ahead/behind enrichment is outside the equivalence claim and must not be silently
dropped by a later production experiment.

## EXP-013 registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, BENCH-008-L, and EXP-010. The readiness invariant is exact
current structural identity: project, stable path-derived ID, path, attached
branch or detached HEAD, primary/missing state, and opaque registration identity.
Optional dirty/ahead/behind/remote enrichment must be absent when unknown and
must return on the next non-startup reconcile; structural evidence never becomes
a provider-wide inventory cache.

Expected files are:

- provider-neutral port and Observer use case:
  `packages/contracts/src/providers.ts`,
  `apps/observer/src/reconcile/providerObservations.ts`,
  `apps/observer/src/reconcile/run/currentObservations.ts`, and
  `apps/observer/src/reconcile/run.ts`;
- Worktrunk adapter:
  `integrations/worktree/worktrunk/src/nativeList.ts` and
  `integrations/worktree/worktrunk/src/provider.ts`;
- focused coverage:
  `integrations/worktree/worktrunk/test/unit/provider.test.ts` and
  `apps/observer/test/integration/reconcile-fake-providers.test.ts`;
- real/stable benchmark and evidence:
  `tests/performance/quick-session/observerWorktrunk.real.test.ts`,
  `tests/performance/quick-session/exp-013.synthetic.json`,
  `tests/performance/quick-session/exp-013.observer-worktrunk.real.json`,
  `tests/performance/quick-session/observer-worktrunk.real.json`, and this ledger;
- architecture behavior: `docs/observer-architecture.md` and
  `docs/generated/observer-architecture-manifest.json` when regeneration detects
  the new adapter dependency.

JSDoc updates are required on the `WorktreeProvider` driven port and its optional
structural method, `readWorktreeObservations`, `runReconcileOnce`, and the
`WorktrunkProvider` class. The new native-list function receives boundary and
structural-evidence JSDoc. No connector JSDoc, configuration, protocol payload,
or command-composition change is expected. A losing result removes the optional
port, native adapter path, policy plumbing, tests, and architecture text while
retaining only the rejected ledger row and raw candidate evidence.

The losing run did exactly that. The checked
`exp-013.observer-worktrunk.real.json` is the complete confirmation matrix that
failed the burst and structural-scan thresholds; `exp-013.synthetic.json`
retains the stable correctness matrix. The generic retained artifacts remain
EXP-010. The only surviving implementation change from the investigation is the
BENCH-009-E event-order correction in the real benchmark harness.

## BENCH-010-P registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `tests/README.md`, BENCH-008-L, EXP-010,
EXP-013, and BENCH-009-E. This diagnostic changes no Station production path;
it isolates startup-read treatment while holding the retained native mutation,
repository shape, and nearby host-load window constant.

Expected files are
`tests/performance/quick-session/startupReadPairedComparison.mjs`,
`tests/performance/quick-session/startup-read-paired-comparison.real.json`,
`tests/README.md`, `package.json`, and this ledger. No backend or connector
JSDoc, contract, configuration, architecture, or generated-manifest change is
expected. The exact paired thresholds and safety invariants are recorded in the
table row; a diagnostic failure leaves production unchanged.

## BENCH-011-H registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `tests/README.md`, EXP-010, EXP-013,
BENCH-009-E, and BENCH-010-P. The diagnostic changes no production behavior and
tests the distinct deferred-enrichment semantic suggested by the failed
structural-only candidate.

Expected files are
`tests/performance/quick-session/startupReadPairedComparison.mjs`,
`tests/performance/quick-session/startup-enrichment-hybrid-comparison.real.json`,
`tests/README.md`, `package.json`, and this ledger. No backend or connector
JSDoc, contract, configuration, architecture, or generated-manifest change is
expected. The exact thresholds and safety conditions are recorded in the table;
a failure leaves production unchanged.

## BENCH-012-W registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `tests/README.md`, EXP-010, BENCH-006-G, and
the rejected EXP-011/EXP-012/BENCH-010-P/BENCH-011-H evidence. This is a
provider-boundary diagnostic only; it changes no Station pool, discovery, or
Quick Session semantics.

Expected files are
`tests/performance/quick-session/pooledWorktreeActivationComparison.mjs`,
`tests/performance/quick-session/pooled-worktree-activation-comparison.real.json`,
`tests/README.md`, `package.json`, and this ledger. No backend or connector
JSDoc, contract, configuration, architecture, or generated-manifest change is
expected. The pool-fill cost, exact thresholds, reset invariants, redaction, and
cleanup requirements are recorded in the table row.

## EXP-014 registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/configuration.md`, `tests/README.md`, EXP-010, and BENCH-012-W. The
invariant is that a claimed slot is an exact, clean, detached registration at
the configured base; any absent, corrupt, stale, dirty, or concurrently changed
evidence becomes visible ordinary provider state and falls back to retained
native creation. The deliberately removed behavior is `git worktree add` only
for launch-bound interactive requests with an exact claimed slot.

Expected files are:

- provider-neutral purpose and Observer call sites:
  `packages/contracts/src/providers.ts`,
  `apps/observer/src/commands/worktree/create.ts`,
  `apps/observer/src/commands/worktree/fork.ts`,
  `apps/observer/src/commands/session/create.ts`, and
  `apps/observer/src/commands/session/fork.ts`;
- Worktrunk adapter:
  `integrations/worktree/worktrunk/src/nativePool.ts` and
  `integrations/worktree/worktrunk/src/provider.ts`;
- focused coverage:
  `integrations/worktree/worktrunk/test/unit/nativePool.test.ts`,
  `integrations/worktree/worktrunk/test/unit/provider.test.ts`, and
  `apps/observer/test/integration/session-commands.test.ts`;
- stable/real benchmark and evidence:
  `tests/performance/quick-session/observerWorktrunk.real.test.ts`,
  `tests/performance/quick-session/exp-014.synthetic.json`,
  `tests/performance/quick-session/exp-014.observer-worktrunk.real.json`,
  `tests/performance/quick-session/observer-worktrunk.real.json`, and this ledger;
- architecture behavior: `docs/observer-architecture.md` and
  `docs/generated/observer-architecture-manifest.json` when regeneration detects
  the new adapter dependency.

JSDoc updates are required on `CreateWorktreeRequest`/the Worktree provider port,
the Worktrunk provider class, and the new native-pool ownership boundary. No
connector JSDoc, configuration schema, composition default, or protocol payload
change is expected in this prototype. A losing result removes the purpose field,
pool module/path, tests, benchmark enablement, and architecture text while
retaining only rejected evidence; normal composition never enables the pool.

Outcome: the registered full matrix rejected the candidate. The focused warm
probe passed, but the confirmation artifact failed six required latency/fill
checks despite passing every correctness gate. The candidate is therefore
removed without a retry, `observer-worktrunk.real.json` remains the EXP-010
winner, and `exp-014.synthetic.json` plus
`exp-014.observer-worktrunk.real.json` retain the losing evidence.

## BENCH-013-V registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`, and
`tests/README.md`; EXP-010 is the production baseline and EXP-014 establishes
that persistent spare registrations are not acceptable. This diagnostic changes
only `package.json`, `tests/README.md`, this ledger, and adds
`tests/performance/quick-session/nativeGitVerificationComparison.mjs` plus
`tests/performance/quick-session/native-git-verification-comparison.real.json`.
No production, contract, configuration, architecture manifest, connector, test
suite, or JSDoc change is authorized by the diagnostic.

The candidate must treat filesystem evidence as a strict boundary: the target
realpath must be exact; `.git` must be a small stable regular file containing one
Git-dir pointer; the resolved administrative directory must be a stable direct
child of the repository common-dir `worktrees`; `HEAD` must name exactly the
requested branch ref; the administrative backlink must name exactly the target
marker; and the marker/administrative directory must survive double-stat checks.
Any mismatch fails the run. Both strategies retain the same pre-mutation bare
guard, native add, registration identity, bound-four scheduling, inventory,
branch uniqueness, cleanup, redaction, and temporary-root removal gates.

Outcome: every BENCH-013-V safety gate passed and its single/burst medians were
decisive, but one candidate-only burst-5 host stall failed the registered p95
rule. The diagnostic and raw artifact remain; no production experiment is
authorized and the already-rejected EXP-011 path is not retried.

## BENCH-014-D registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, EXP-010, BENCH-010-P, and BENCH-011-H. This diagnostic updates
only `tests/performance/quick-session/startupReadPairedComparison.mjs`,
`package.json`, `tests/README.md`, this ledger, and adds
`tests/performance/quick-session/deferred-startup-discovery-comparison.real.json`.
No production, contract, configuration, architecture manifest, connector, test
suite, or JSDoc change is authorized.

The deferred candidate may remove enriched discovery only from the measured
interactive interval; it must still complete that exact read before reset and
prove the full post-create inventory. The control must prove the initial
inventory before creation. Both lanes retain the same native bare/add/rev-parse
path, bound-four scheduler, exact final inventory, branch/path uniqueness,
cleanup to 49, redaction, and temporary-root removal. A passing diagnostic can
only preregister an Observer prototype; it cannot itself justify a readiness
change.

Outcome: cold latency, deferred-read p95, and all correctness gates supported the
hypothesis, but the registered warm-tail gate failed. The diagnostic therefore
does not authorize the Observer prototype. The raw evidence remains in
`deferred-startup-discovery-comparison.real.json`; production and the generic
retained EXP-010 artifact are unchanged.

## BENCH-015-T registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/harness-signals.md`, `tests/README.md`,
and EXP-010. BENCH-004-R establishes the current measurement gap: it preserves
terminal and harness stage timestamps but intentionally uses instrumented fakes
at those boundaries. This diagnostic measures the real Station Host transport
and PTY without changing Observer, dashboard, provider, or harness behavior.

Expected files are
`tests/performance/quick-session/quickSessionPty.real.test.ts`,
`tests/performance/quick-session/quick-session-pty.real.json`, `package.json`,
`tests/README.md`, and this ledger. It may invoke the existing Station package
link, node-pty repair, and ctty-helper build scripts as setup, but changes none
of them. No backend or connector JSDoc, contract, configuration, architecture,
generated manifest, production source, or ordinary test-suite change is
expected.

The child protocol uses unique content-free ready and acknowledgement markers.
The measured interactive boundary ends only after an exact controller
attachment writes a token and that exact child acknowledges it. Both source
bridge and compiled-style Bun PTYs use the same Host protocol and scenario
matrix. A latency miss changes only the next hypothesis; an identity, input,
inventory, host-shutdown, stderr, or temporary-root failure rejects the
diagnostic implementation itself.

Outcome: after correcting only an overlong sandbox socket path, two real runs
independently lost a Bun ready marker after successful spawn and attach. The
partial artifact retains every completed sample and cleanup proof, but the
mandatory readiness gate prevents latency classification. No production change
was made by BENCH-015-T.

## EXP-015 registered change plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/harness-signals.md`, `tests/README.md`, EXP-010, and BENCH-015-T. Runtime
evidence is the two independent missing-ready failures plus the partial real
artifact; the current client unit test deliberately yields between attach
acknowledgement and its first frame and therefore does not cover this ordering.

Expected files are:

- Host client source and focused coverage:
  `packages/station-host/src/client.ts` and
  `packages/station-host/test/unit/client.test.ts`;
- real benchmark and evidence:
  `tests/performance/quick-session/quickSessionPty.real.test.ts`,
  `tests/performance/quick-session/quick-session-pty.real.json`, and this ledger;
- behavior documentation: `docs/architecture.md`.

The `HostAttachment` JSDoc will state that a valid attempt includes frames sent
immediately after its acknowledgement. No connector JSDoc, shared wire schema,
protocol version, configuration, Observer dependency, generated architecture
manifest, or dashboard behavior change is expected. The invariant is that only
a strictly parsed, exact acknowledgement can make a provisional sink current;
a failed or mismatched replacement cannot disturb the earlier valid sink. The
behavior deliberately removed is silently discarding a live frame during the
response-to-promise-continuation window. A losing result restores the client
mechanism and its tests while retaining BENCH-015-T evidence.

Outcome: removing the test's deliberate event-loop yield reproduced the lost
frame deterministically. Reducing the strictly parsed attach response and
installing its sink before resolving the request made that test pass and removed
all readiness losses from two complete 300-session candidate matrices. The
checked confirmation artifact records Bun median/p95 of 4/6ms warm, 6/9ms for
burst-3, 9/12ms for burst-5, and 28/32ms for burst-20. Its cold Host-start
median/p95 is 120/521ms, so BENCH-015-T's generic cold classification remains a
failure even though EXP-015's separately registered warm/burst gates all pass.
The source bridge remains much slower at 90/110ms warm, 148/172ms burst-5, and
475/574ms burst-20. Every completed Host/session/identity/input/inventory/close
and cleanup assertion passed. Stable repository build, typecheck, 3,012 unit
tests, 162 diagnostics tests, Station typecheck, 49 Host units, and 67 focused
Station Host/attached-terminal tests passed. EXP-015 is retained; the next
benchmark must compose warmed real Bun PTY readiness with the retained EXP-010
Observer/Worktrunk path rather than charging ordinary Quick Session latency for
a new Host daemon on every session.

## BENCH-016-E registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/harness-signals.md`, `tests/README.md`, EXP-010, BENCH-015-T, and EXP-015.
This diagnostic changes no production, protocol, Observer, terminal adapter,
Worktrunk adapter, configuration, or dashboard behavior. It extends the retained
real Observer harness with an opt-in end-to-end mode so the fake-boundary and
real-boundary lanes share the same repository shape, command path, stage model,
and verification rules.

Expected files are
`tests/performance/quick-session/observerWorktrunk.real.test.ts`,
`tests/performance/quick-session/observer-host-pty.real.json`, `package.json`,
`tests/README.md`, and this ledger. No backend or connector JSDoc, shared
contract, architecture text, configuration reference, or generated manifest
change is expected.

Each measured fixture must start only after its Bun Host is healthy and one
setup-only PTY spawn/attach/close has restored empty inventory, so `cold-single`
means an ordinary cold Observer over the already-running, runtime-warmed daemon.
The benchmark shell emits one content-free ready marker, acknowledges one exact
controller token, and then stays alive. Exact immutable attach identity is
derived from `host.list`; replay and live frames are both accepted. The PTY must
remain live through canonical post-launch reconciliation, then detach and close
before the Host stops. Any marker, input, identity, projection, scan, concurrency,
Host, repository-inventory, stderr, or cleanup failure rejects the diagnostic
regardless of latency. The exact classification thresholds and 108-session
matrix are registered in the ledger row above.

Outcome: all 108 sessions and every correctness/cleanup condition passed, but
all four registered p95 latency thresholds failed. The checked artifact records
median/p95 of 64/262ms warm, 306/579ms cold, 166/407ms burst-5, and 525/1636ms
burst-20. Burst-3 and two-project parallel remained 83/91ms and 156/170ms. The
tail was not confined to Host readiness: the slow repetitions also inflated
native Git mutation and coordinator queue time, while real launch/readiness/input
reached 33ms warm, 138ms burst-5, and 210ms burst-20 p95. The additive claim is
therefore rejected without a retry. The lane and
`observer-host-pty.real.json` remain as valid end-to-end safety and tail-latency
evidence; production remains EXP-010 plus EXP-015. A paired same-window control
is required before attributing the shared subprocess slowdown to Host activity.

## BENCH-017-A registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/harness-signals.md`, `tests/README.md`, EXP-010, EXP-015, and BENCH-016-E.
This diagnostic extends only the benchmark harness; it changes no production,
contract, configuration, architecture, generated manifest, or JSDoc.

Expected files are
`tests/performance/quick-session/observerWorktrunk.real.test.ts`,
`tests/performance/quick-session/observer-host-pty-paired.real.json`,
`package.json`, `tests/README.md`, and this ledger. Each scenario runs adjacent
three-repetition blocks in counterbalanced boundary order on the same shaped
projects. Both boundaries start, health-check, runtime-warm, and retain an idle
Bun Host during the measured interval; only the real boundary gives the
production Station terminal adapter access to it. This isolates active PTY work
from daemon/setup presence while keeping cleanup identical.

The report computes provider blocking from each raw sample's queue/preflight,
repository mutation, and authoritative worktree observation stages; terminal
work is launch/spawn, readiness, canonical projection, and acknowledged input.
The exact ratio decision and prediction are registered in the table. Any failed
fake or real safety gate rejects the diagnostic implementation before timing is
interpreted.

Outcome: the full paired matrix rejected the contention prediction. Real/fake
provider-blocking p95 ratios were 0.95 for burst-5 and 0.37 for burst-20, both
far below 1.25; warm was 1.07 as predicted, but cannot rescue the required burst
claim. Real terminal work itself stayed modest at 9ms warm, 18ms burst-5, and
23ms burst-20 p95. The slow provider tail instead landed unevenly on both
boundaries: fake burst-20 p95 was 1283ms while its Host pair was 445ms, whereas
the Host multi-project p95 was 794ms versus fake 289ms. All 216 sessions and 36
Host lifecycles passed exact safety and cleanup gates. The diagnostic and
`observer-host-pty-paired.real.json` remain; no scheduling or launch-order
production hypothesis is authorized by this result.

## BENCH-018-P registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, EXP-010, BENCH-012-W, EXP-014, and BENCH-017-A. This is an
isolated provider-boundary diagnostic; it changes no production pool ownership,
provider contract, configuration, Observer behavior, architecture, generated
manifest, or JSDoc.

Expected files are
`tests/performance/quick-session/pooledWorktreeActivationComparison.mjs`,
`tests/performance/quick-session/pooled-worktree-five-slot-comparison.real.json`,
`package.json`, `tests/README.md`, and this ledger. The existing pool-20 command
and defaults must remain reproducible. The new mode creates exactly five slots;
pooled strategy commands beyond that capacity use the retained native add and
verification path. The report distinguishes each command's activation or
fallback mechanism and records the fifth completion separately from final wall
time.

The exact timing thresholds and prediction are registered in the ledger row.
Both strategies retain the same bare guard, rev-parse verification, bound-four
admission, alternating order, five fresh repositories, inventory parser,
redaction, reset, and root-removal checks. Any slot/fallback/identity/inventory
or cleanup failure rejects the diagnostic before latency is interpreted.

Outcome: five slots fixed the persistent-capacity cost and decisively improved
single and five-session work, but the interleaved burst-20 hybrid failed both
registered p95 gates. Pool fill was 58/126ms median/p95, single activation was
36/118ms versus native 124/220ms, and burst-5 was 71/73ms versus 136/389ms.
Burst-20 medians also supported the idea—first five 178→97ms and final
482→422ms—but one hybrid run reached 587ms for the fifth completion and 1398ms
final versus native p95 228/511ms. All exact five-activation/15-fallback,
inventory, reset, cleanup, and root-removal checks passed. The result rejects
the interleaved hybrid without authorizing a production pool and isolates mixed
activation/fallback scheduling as the next falsifiable question.

## BENCH-019-W registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, EXP-010, BENCH-012-W, EXP-014, and BENCH-018-P. This remains
an isolated provider-boundary diagnostic with no production, contract,
configuration, Observer, architecture, manifest, or JSDoc change.

Expected files are
`tests/performance/quick-session/pooledWorktreeActivationComparison.mjs`,
`tests/performance/quick-session/pooled-worktree-five-slot-phased.real.json`,
`package.json`, `tests/README.md`, and this ledger. The original pool-20 and
five-slot-interleaved modes remain byte-for-behavior compatible. Only five-slot
burst overflow changes: all activation commands settle before fallback admission.
The report records the maximum activation completion and minimum fallback start
and requires their ordering to be non-overlapping.

The exact latency gates and prediction are registered in the table. Existing
bare guard, verification, bound-four, alternating strategy order, five-repository
shape, strict inventory, cleanup, redaction, and root-removal behavior remains
mandatory.

Outcome: exact phase ordering passed but the p95 hypothesis failed. Pool fill
was 51/74ms median/p95, single and burst-5 retained 39–46% median/p95 wins, and
four of five phased burst-20 samples made the first five interactive in 61–64ms
and finished in 326–329ms. One activation-only stall reached 467ms before any
fallback began and the final run reached 1359ms, failing the registered 160/614ms
p95 limits. All 290 operations and every phase, identity, inventory, reset,
cleanup, and root-removal gate passed. This rejects overlap as the tail cause;
the pool family is not advanced or retried.

## BENCH-020-RM registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, EXP-010, and the historical removal trace evidence in the
task brief. This is a provider-boundary diagnostic; it changes no production,
contract, configuration, Observer coordination, architecture, manifest, or
JSDoc.

Expected files are
`tests/performance/quick-session/nativeGitRemoveComparison.mjs`,
`tests/performance/quick-session/native-git-remove-comparison.real.json`,
`package.json`, `tests/README.md`, and this ledger. Worktrunk removal uses the
same empty isolated config, `--no-hooks`, forced unique-branch deletion, and
selected-checkout context as the adapter. Native removal must first parse strict
Git porcelain structural inventory and match the exact requested path, branch,
and administrative registration identity; it then removes the exact path and
deletes only that unique branch.

The exact performance thresholds and prediction are registered in the table.
Both strategies use the same bound-four admission, alternating order, fresh
worktrees, inventory/branch absence proof, resource/load recording, redaction,
cleanup baseline, and five-root removal gate.

Outcome: native removal was safe and dramatically faster in typical and
burst-20 samples, but failed the registered all-scenario tail rule. Single
median/p95 improved 543/619→64/356ms, burst-5 improved 1400/1468→165/953ms,
and burst-20 improved 4912/7207→465/624ms. The burst-5 p95 improvement was
35.1%, below the required 40%; two native samples stalled together to 788ms and
953ms during elevated host load. All 290 removals and every identity, inventory,
branch-deletion, concurrency, cleanup, redaction, and root-removal gate passed.
The diagnostic is rejected without retry and authorizes no production native
removal path.

## BENCH-021-B registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, EXP-010, BENCH-005-P, and BENCH-020-RM. This is an isolated
provider-boundary diagnostic; it changes no production, contract, configuration,
Observer coordination, architecture, manifest, or JSDoc.

Expected files are
`tests/performance/quick-session/nativeGitBareSingleflightComparison.mjs`,
`tests/performance/quick-session/native-git-bare-singleflight-comparison.real.json`,
`package.json`, `tests/README.md`, and this ledger. Both strategies run the same
native add, exact process verification, and administrative registration proof.
The candidate shares only a currently pending bare-probe promise and evicts that
promise at settlement; it does not cache a successful verdict across later
admissions.

The exact process-count, performance, and regression thresholds are registered
in the table. Both strategies retain bound-four admission, alternating order,
five fresh repositories, strict inventory comparison, branch/path uniqueness,
cleanup, redaction, and root-removal gates. A deterministic settled-eviction
check must show that simultaneous callers share one result while a later caller
executes a new probe. Any safety failure rejects latency interpretation.

Outcome: in-flight sharing removed the intended subprocesses but synchronized
the following Git mutations and lost the performance hypothesis. Probe counts
fell from 5→2 and 20→5–8, while burst-5 median/p95 worsened
163/583→266/1128ms and burst-20 median worsened 474→982ms; single p95 also
regressed 244→358ms. Every path, branch, process-verification, registration,
inventory, bound, cleanup, redaction, settled-eviction, and root-removal check
passed. The valid diagnostic is rejected without retry and authorizes no
production probe sharing.

## BENCH-022-C registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, EXP-004, EXP-010, BENCH-007-G, and BENCH-021-B. This is an
isolated provider-pressure diagnostic; it changes no production coordinator,
provider contract, configuration, Observer behavior, architecture, manifest, or
JSDoc.

Expected files are
`tests/performance/quick-session/nativeGitBoundThreeComparison.mjs`,
`tests/performance/quick-session/native-git-bound-three-comparison.real.json`,
`package.json`, `tests/README.md`, and this ledger. Both strategies execute the
same retained bare probe, native add, exact process verification, and
administrative registration proof; only bounded admission changes from four to
three.

The exact improvement and regression thresholds are registered in the table.
Both strategies retain alternating order, five fresh 49-worktree repositories,
strict inventory equality, branch/path uniqueness, cleanup, resource/load
recording, redaction, and root-removal gates. Any safety failure rejects latency
interpretation.

Outcome: the longer sequence rejected first-execution warmup as the explanation.
Positions 2–20 intent/ensure p95 remained 711/670ms. Ensures above 500ms
occurred at positions 1, 8, 9, 13, and 14, so only 20% were early; full medians
were still 174/164ms. All 20 strict position, milestone, current-identity,
interaction, inventory, stop, stderr, and root gates passed. Load average stayed
29–31 and the slow samples remained primarily pre-`host.start`. No sample may be
discarded; periodic process scheduling is the residual tail.

## BENCH-031-H registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/development.md`, `tests/README.md`, EXP-015, BENCH-024-H,
BENCH-026-I, BENCH-027-C, and BENCH-030-S. This is a compiled product-path
composition diagnostic and changes no production Host lifecycle, Observer
readiness, terminal provider, contract, configuration, architecture, manifest,
or backend/connector JSDoc.

Expected files are
`tests/performance/quick-session/hostPrewarmComparison.real.test.ts`,
`tests/performance/quick-session/compiled-host-prewarm.real.json`,
`package.json`, `tests/README.md`, and this ledger. A new opt-in mode builds the
current binary outside timing and selects its `__station-host` command; the
existing source command and artifact remain the default. Both arms retain fresh
state, real Worktrunk discovery, packaged Bun PTY readiness, and controller
input acknowledgement.

The exact 50%/300ms latency, 10% scan, and four-of-five early-settle thresholds
are registered in the table. Current identity, one shared ensure, exact
inventory, immutable PTY identity/input, live/empty Host inventory, stop,
stderr, alternating order, and all Host/repository-root removals are mandatory.
Binary build time is setup evidence only. Any shifted startup work or safety
failure rejects latency interpretation.

Outcome: bound three exposed a real but losing throughput-versus-tail tradeoff.
Burst-20 p95 improved 829→494ms and mutation p95 improved 122→51ms, while
final median regressed 405→480ms. Burst-5 median improved only 6% and p95
regressed 141→167ms. All 30 strategy runs passed exact identity, inventory,
peak-bound, cleanup, redaction, and root-removal checks. The registered
all-metric rule rejects a global bound change without retry.

## BENCH-023-A registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, EXP-004, EXP-010, BENCH-007-G, BENCH-021-B, and BENCH-022-C.
This remains an isolated provider-pressure diagnostic with no production,
contract, configuration, Observer, architecture, manifest, or JSDoc change.

Expected files are `tests/performance/quick-session/nativeGitConcurrency.mjs`,
`tests/performance/quick-session/native-git-adaptive-overflow.real.json`,
`package.json`, `tests/README.md`, and this ledger. The existing four-versus-eight
command and artifact defaults remain unchanged. The new opt-in mode compares
the same native `git worktree add` commands under bound four and an overflow
policy that begins at four but permits at most three active mutations after the
first completion when the initial burst exceeds five.

The exact performance and regression thresholds are registered in the table.
Both strategies retain alternating order, five fresh repositories, exact
path/branch inventory, concurrency instrumentation, cleanup-to-49, load/resource
recording, and root-removal gates. Any transition or safety failure rejects the
timing result.

Outcome: the overflow transition was exact but did not stabilize this paired
window. Burst-20 median/p95 regressed 264/382→306/425ms, and the identical
four-wide burst-5 candidate arm hit a 598ms host outlier versus 198ms control.
All 30 runs passed identity, inventory, scheduling, cleanup, and root-removal
checks. The result rejects adaptive overflow and closes the admission-bound
family without retry.

## BENCH-024-H registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, EXP-010, EXP-015, BENCH-015-T, and BENCH-016-E. This is a
composition-boundary diagnostic; it changes no production Host lifecycle,
terminal provider, Observer readiness, contract, configuration, architecture,
manifest, or JSDoc.

Expected files are
`tests/performance/quick-session/hostPrewarmComparison.real.test.ts`,
`tests/performance/quick-session/host-prewarm-comparison.real.json`,
`package.json`, `tests/README.md`, and this ledger. Each paired arm uses the same
fresh Host command, real Bun PTY, strict attachment identity, content-free ready
and input-acknowledgement markers, and real Worktrunk read of one unchanged
49-worktree repository. Only the candidate begins ensure before that read and
retains its pending result for launch.

The exact improvement and startup-regression thresholds are registered in the
table. Alternating order, compatible health, exact Worktrunk inventory, PTY
identity/input, live and empty Host inventories, stop, stderr, and removal of
every temporary root are mandatory. Any shifted startup cost or safety failure
rejects latency interpretation.

Outcome: the 60MB Host-only executable improved median intent and ensure by
31%/33% but failed every tail condition. Monolithic→dedicated intent p95 was
1028→1175ms and ensure p95 was 1014→1124ms. Both binaries' first measured
launch supplied the roughly one-second outlier, while later ensure samples were
108–237ms. All ten current-identity, milestone, interaction, inventory, stop,
stderr, candidate-removal, and state-root gates passed. Binary size is rejected
as the tail cause and no second executable advances.

## BENCH-030-S registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/development.md`, `tests/README.md`, BENCH-026-I, BENCH-028-M, and
BENCH-029-D. This is a sampling-semantics diagnostic using existing product code
and logs; it changes no production implementation, packaging, protocol,
configuration, architecture, manifest, or backend/connector JSDoc.

Expected files are
`tests/performance/quick-session/compiledHostEntry.real.test.ts`,
`tests/performance/quick-session/compiled-host-sequence.real.json`,
`package.json`, `tests/README.md`, and this ledger. The new lane builds the
current all-in-one binary once, then records 20 sequential no-ctty Host
lifecycles with their exact positions. It reports full and positions 2–20
distributions without discarding or overwriting the first sample.

The exact 300ms steady-tail, 80% positional-concentration, and 20-run rules are
registered in the table. Current identity, milestones, health, spawn, PTY
identity/input, live/empty inventory, stop, stderr, and fresh-root removal remain
mandatory. Any later repeated tail or safety failure rejects the first-launch
interpretation.

Outcome: prewarm overlapped discovery safely but did not have enough runway.
On-demand→prewarmed intent-to-ack median/p95 was 597/1946→367/2150ms;
startup scan median changed only +1.0% and p95 improved. No candidate Host was
healthy before the immediate post-scan intent because ensure itself took
584–2414ms. All ten Host, PTY, identity, input, inventory, stop, stderr, and
root-removal gates passed. The registered 60%/100ms rules reject prewarm alone
without authorizing shifted startup work.

## BENCH-025-E registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, BENCH-015-T, EXP-015, and BENCH-024-H. This is an isolated
executable-entry diagnostic; it changes no production Host command, lifecycle,
terminal provider, Observer readiness, contract, configuration, architecture,
manifest, or JSDoc.

Expected files are
`tests/performance/quick-session/hostEntryComparison.real.test.ts`,
`tests/performance/quick-session/host-entry-comparison.real.json`,
`package.json`, `tests/README.md`, and this ledger. The candidate bundle is made
once in a removable temporary directory before any measured Host launch. Both
arms use the same Bun executable, Host build-version override, real Bun PTY,
strict attachment identity, content-free ready and input-acknowledgement
markers, and fresh Host state.

The exact improvement and absolute-tail thresholds are registered in the table.
Alternating order, compatible health, one spawn, PTY identity/input, live and
empty Host inventories, stop, stderr, and removal of every Host and bundle root
are mandatory. Bundle construction time is recorded as setup evidence but is
excluded from the cold-launch headline. Any unsafe run, undeclared runtime
external, or cleanup failure rejects latency interpretation.

Outcome: after correcting only the bundle-relative helper fixture, the
registered matrix passed. Source→bundle intent-to-ack median/p95 was
186/412→122/225ms, while ensure tightened from 165/262 to 110/112ms. The
one-time 83ms, 1.79MB bundle had no non-platform runtime imports. All ten Host,
PTY, identity, inventory, stop, stderr, and cleanup gates passed. Because the
installed binary already owns a compiled `__station-host` entry, the diagnostic
advances that existing boundary to a direct product-path comparison instead of
authorizing a second production bundle.

## BENCH-026-I registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/development.md`, `tests/README.md`, BENCH-015-T, EXP-015, BENCH-024-H,
and BENCH-025-E. This validates the installed executable boundary and changes no
production Host command, packaging, lifecycle, terminal provider, Observer,
contract, configuration, architecture, manifest, or backend/connector JSDoc.

Expected files are
`tests/performance/quick-session/hostEntryComparison.real.test.ts`,
`tests/performance/quick-session/compiledHostEntry.real.test.ts`,
`tests/performance/quick-session/compiled-host-entry.real.json`, `package.json`,
`tests/README.md`, and this ledger. The existing harness will expose only its
shared real-Host runner; the new opt-in lane builds the current binary before
timing and compares `[bun, hostMain.ts]` with `[stn, __station-host]`. Both arms
use fresh state and perform the same strict attachment and interaction proof.

The exact improvement and absolute-tail thresholds are registered in the table.
Alternating order, current binary identity, compatible health, one spawn, PTY
identity/input, live and empty Host inventories, stop, stderr, and removal of
every temporary Host root are mandatory. Binary build time is recorded as setup
evidence but excluded from the latency distributions. Any build, safety, or
cleanup failure rejects latency interpretation.

Outcome: compiled self-dispatch improved the highly loaded paired source window,
but it missed the absolute tail rule. Source→compiled intent-to-ack median/p95
was 804/2311→475/1343ms; compiled ensure was 378/1280ms and post-ensure
interaction was 23/97ms. All ten identity, Host, PTY, inventory, stop, stderr,
and cleanup gates passed. The 78MB binary took 6.87s to build outside timing.
The result rejects the existing compiled boundary as sufficient and advances
its fresh packaged-helper preparation as the next attribution target.

## BENCH-027-C registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/development.md`, `tests/README.md`, BENCH-015-T, EXP-015, BENCH-025-E,
and BENCH-026-I. This is an installed-runtime attribution diagnostic; it changes
no production terminal implementation, helper packaging, Host command,
Observer, contract, configuration, architecture, manifest, or backend/connector
JSDoc.

Expected files are
`tests/performance/quick-session/hostEntryComparison.real.test.ts`,
`tests/performance/quick-session/compiledHostEntry.real.test.ts`,
`tests/performance/quick-session/compiled-host-asset-comparison.real.json`,
`package.json`, `tests/README.md`, and this ledger. The harness will accept an
explicit PTY implementation and compare the same compiled binary under `bun`
and supported diagnostic `bun-nocctty` selection on fresh state. Both arms
retain the exact content-free interaction proof; the candidate is attribution
only because it does not provide controlling-terminal parity.

The exact 25% attribution thresholds are registered in the table. Alternating
order, current build identity, compatible health, one spawn, PTY identity/input,
live and empty Host inventories, stop, stderr, and removal of every temporary
Host root are mandatory. Binary build time remains setup evidence. Any build,
safety, or cleanup failure rejects latency interpretation.

Outcome: helper preparation materially affected typical startup but did not
explain the tail. Packaged→no-ctty intent median/p95 was
337/1344→171/1132ms; ensure was 321/1327→163/1090ms. Both median
improvements were 49%, while p95 improved only 16–18% and missed the registered
25% rule. All ten same-binary interaction and cleanup gates passed. The result
rejects removal of controlling-terminal correctness and does not prioritize
helper setup ahead of the residual executable tail.

## BENCH-028-M registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/development.md`, `tests/README.md`, BENCH-026-I, and BENCH-027-C. This
uses the existing `host.start` observability record and adds no production log,
Host, protocol, configuration, architecture, manifest, or backend/connector
JSDoc change.

Expected files are
`tests/performance/quick-session/hostEntryComparison.real.test.ts`,
`tests/performance/quick-session/compiledHostEntry.real.test.ts`,
`tests/performance/quick-session/compiled-host-milestones.real.json`,
`package.json`, `tests/README.md`, and this ledger. The shared harness will read
the strict Host log before removing state and translate its ISO timestamp
against an adjacent intent wall-clock sample. The new lane runs five compiled
`bun-nocctty` lifecycles so helper setup does not obscure executable startup.

The exact 75%/50% attribution rules are registered in the table. Every phase
must be nonnegative and sum to ensure within 25ms wall-clock tolerance. Current
build identity, health, spawn, PTY identity/input, live/empty inventory, stop,
stderr, strict log parse, and root removal remain mandatory. Any safety or
clock-coherence failure rejects attribution.

Outcome: the milestone split confirmed the prediction. No-ctty ensure
median/p95 was 161/1013ms; intent-to-`host.start` was 133/993ms and therefore
98% of ensure p95. Post-start through polled health was only 29/88ms p95. All
five strict log parses, phase sums, clock-coherence checks, current identity,
Host/PTTY/input/inventory/stop/stderr, and root removals passed. Polling is not
the dominant target; executable pre-start is.

## BENCH-029-D registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/development.md`, `tests/README.md`, BENCH-025-E, BENCH-026-I,
BENCH-027-C, and BENCH-028-M. This is a temporary packaging diagnostic and
changes no production binary, Host command, asset policy, protocol,
configuration, architecture, manifest, or backend/connector JSDoc.

Expected files are
`tests/performance/quick-session/compiledHostEntry.real.test.ts`,
`tests/performance/quick-session/dedicated-host-binary-comparison.real.json`,
`package.json`, `tests/README.md`, and this ledger. The lane will compile
`hostMain.ts` once into a removable dedicated executable using the current
version and build identity, then compare it with the current all-in-one binary.
Both use `bun-nocctty` so embedded helper work cannot mask executable startup.

The exact improvement, absolute-tail, and size thresholds are registered in the
table. Alternating order, current identity, strict Host milestones, health,
spawn, PTY identity/input, live/empty inventory, stop, stderr, and removal of
the candidate executable root plus all state roots are mandatory. Compile time
is recorded but excluded. Any compile, safety, identity, or cleanup failure
rejects latency interpretation.

Outcome: compiled fresh-state prewarm improved the tail but failed the complete
rule and shifted contention. On-demand→prewarm intent median/p95 was
330/1402→234/249ms; median improved only 29% and no ensure settled before
intent. Scan median improved, but p95 regressed 326→1043ms when Host startup
and Worktrunk stalled together. All ten current-identity, one-ensure, inventory,
PTY/input, stop, stderr, and root gates passed. Fresh prewarm does not advance.

## BENCH-032-R registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/development.md`, `tests/README.md`, EXP-015, BENCH-031-H, and the stated
ordinary-Observer-restart completion criterion. This remains a diagnostic and
changes no production Host lifecycle, Observer readiness, terminal provider,
contract, configuration, architecture, manifest, or backend/connector JSDoc.

Expected files are
`tests/performance/quick-session/hostPrewarmComparison.real.test.ts`,
`tests/performance/quick-session/compiled-host-prewarm-cached.real.json`,
`package.json`, `tests/README.md`, and this ledger. An opt-in cached-state mode
will start and stop one exact idle compiled Host before each measured strategy,
using the same state root so packaged assets and executable state model prior
Host use. The seed's duration and safety are recorded outside startup/intent
timing; the measured Host remains a separate new process.

The exact 50%/100ms latency, 10% scan, and four-of-five early-settle thresholds
are registered in the table. Seed health, empty inventory, stop, stderr,
current identity, measured ensure, Worktrunk inventory, PTY identity/input,
live/empty inventory, stop, alternating order, and all removals are mandatory.
Any seed, safety, cleanup, or shifted-scan failure rejects the result.

Outcome: cached restart state produced a large safe latency win but missed the
registered completion boundary. On-demand→prewarm intent-to-ack median/p95 was
171/171→16/68ms, while startup-scan median/p95 was 241/263→214/265ms. All
five candidate ensures completed only after intent, by 1–68ms, so the required
four early settles became zero. Every seed, current-build identity, single
measured ensure/spawn, 49-worktree inventory, PTY/input, live/empty inventory,
stop, stderr, alternating-order, and root-removal gate passed. The result is
rejected without weakening its preregistered rule.

## BENCH-033-G registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/configuration.md`, `docs/development.md`, `tests/README.md`, EXP-015,
BENCH-031-H, BENCH-032-R, `apps/observer/src/runtime/main.ts`, and
`apps/cli/src/observerProviders.ts`. This is an actual-runtime composition
diagnostic and changes no production Host lifecycle, provider ownership,
Observer dependency direction or readiness, contract, configuration,
architecture, manifest, or backend/connector JSDoc.

Expected files are
`tests/performance/quick-session/hostPrewarmComparison.real.test.ts`,
`tests/performance/quick-session/compiled-host-prewarm-observer.real.json`,
`package.json`, `tests/README.md`, and this ledger. A new opt-in mode will start
`runObserverMain` against the real 49-worktree project. The candidate starts one
shared compiled Host ensure inside provider-registry construction and retains
that exact promise for the first post-ready PTY interaction; the control starts
ensure only after Observer readiness. Both arms receive the same exact cached
idle-Host seed outside measurement.

The exact 50%/100ms latency, 10% Observer-readiness and startup-scan, and
four-of-five before-readiness thresholds are registered in the table. Current
binary identity, one ensure/spawn, ready health with exactly 49 worktrees, one
startup scan, PTY identity/input, live/empty Host inventory, clean Observer and
Host stops, empty Host stderr, alternating order, and all state/repository-root
removals are mandatory. Seed duration is recorded setup evidence. Any startup,
safety, cleanup, or shifted-readiness failure rejects the result.

Outcome: actual provider composition supplied enough genuine runway in four of
five candidates but did not bound the post-ready tail. On-demand→prewarm
intent-to-ack median/p95 was 594/900→180/924ms. Candidate startup-scan and
Observer-startup p95 improved 67% and 66% in the paired window, and four Hosts
were healthy before readiness, but one already-healthy Host still required
924ms for the measured PTY interaction. All ten seeds, current identities,
single measured ensures/spawns, ready 49-worktree snapshots, one pre-ready
startup scan, PTY/input/inventory, Observer/Host stop, stderr, and root-removal
gates passed. The registered 100ms tail rule rejects composition prewarm.

## BENCH-034-L registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/configuration.md`, `docs/development.md`, `tests/README.md`, EXP-015,
BENCH-032-R, BENCH-033-G, `apps/observer/src/runtime/main.ts`, and the stated
ordinary-Observer-restart completion criterion. This remains an actual-runtime
lifecycle diagnostic and changes no production Host ownership, Observer
composition or readiness, protocol, contract, configuration, architecture,
manifest, or backend/connector JSDoc.

Expected files are
`tests/performance/quick-session/hostPrewarmComparison.real.test.ts`,
`tests/performance/quick-session/compiled-host-observer-restart-live.real.json`,
`package.json`, `tests/README.md`, and this ledger. A new opt-in mode gives both
arms the same current compiled Host plus one strict PTY spawn/attach/ready/input
acknowledgement/close warmup before measured Observer startup. The control
stops that Host and starts a replacement only after readiness; the candidate
leaves it healthy with empty inventory across `runObserverMain`, then performs
one measured controller ensure and the same new PTY interaction.

The exact 75%/100ms intent, 25ms ensure, 10% Observer-readiness and startup-scan,
and five-of-five pre-start-health thresholds are registered in the table.
Current binary identity, warmup and measured immutable PTY identities, exact
input acknowledgements, empty inventories, expected setup/measured spawn
counts, ready 49-worktree snapshot, one pre-ready startup scan, clean
Observer/Host stops, empty stderr, alternating order, and all root removals are
mandatory. Warmup duration is recorded setup evidence and excluded from
measured startup and intent. Any unsafe, shifted-readiness, or cleanup result
rejects the candidate.

Outcome: preserving the exact PTY-used Host proved process survival but failed
the bounded-latency rule. Replacement→preserved intent median/p95 was
341/515→169/604ms, while measured ensure fell from 163/214 to 4.9/31.7ms.
All five candidate Hosts were healthy with empty inventory before Observer
startup. Candidate scan and Observer-startup medians improved 11%/10%, but one
978/1315ms sample regressed both p95s by more than 250%. Every warmup and
measured PTY identity/input, expected spawn count, ready 49-worktree snapshot,
one pre-ready scan, inventory, Observer/Host stop, stderr, alternating-order,
and root-removal gate passed. A live Host is necessary evidence for ordinary
restart behavior but is not sufficient to advance a latency claim.

## BENCH-035-P registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/configuration.md`, `docs/development.md`, `tests/README.md`, EXP-015,
BENCH-033-G, BENCH-034-L, and the Host protocol/attachment ordering retained by
EXP-015. This is timing attribution only and changes no production Host, PTY,
Observer, protocol, contract, configuration, architecture, manifest, or
backend/connector JSDoc.

Expected files are
`tests/performance/quick-session/hostPrewarmComparison.real.test.ts`,
`tests/performance/quick-session/compiled-host-observer-restart-phases.real.json`,
`package.json`, `tests/README.md`, and this ledger. A new opt-in ten-run mode
retains the BENCH-034-L candidate setup: one exact compiled Host PTY warmup,
empty inventory, live Host across actual Observer startup, and one new measured
PTY. It adds adjacent monotonic timestamps for ensure, health, spawn response,
attach, ready marker, and input acknowledgement without changing their order.

The exact 10ms phase-sum, 60%-of-p95, two-slow-sample 50%, and ten-safe-run
rules are registered in the table. Current identity, setup and measured PTY
identity/input, live/empty inventories, ready 49-worktree Observer, one
pre-ready scan, clean Observer/Host stops, empty stderr, and every root removal
remain mandatory. Any negative/incoherent phase or safety failure rejects
attribution; no latency optimization advances merely because one sample is
large.

Outcome: phase attribution passed while disproving the registered prediction.
Preserved-Host intent median/p95 was 153/279ms. Intent through ensure settlement
supplied 269ms, or 96% of total p95, and at least half of every one of the ten
samples above 100ms. Measured ensure itself was only 3.0/7.8ms; health, spawn
response, attach, child readiness, and input acknowledgement each had p95 at or
below 5.0ms. Every phase sum matched total intent exactly and all ten Host,
Observer, Worktrunk, PTY/input, stop, stderr, and root gates passed. Host/PTTY
work is rejected as the next target; the pre-call event-loop boundary advances.

## BENCH-036-X registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/configuration.md`, `docs/development.md`, `tests/README.md`, EXP-015,
BENCH-034-L, BENCH-035-P, `apps/observer/src/runtime/main.ts`,
`apps/observer/src/runtime/observerReap.ts`, and the compiled `__observer`
route. This is a process-boundary diagnostic and changes no production Host,
Observer lifecycle, duplicate inspection, PTY, protocol, contract,
configuration, architecture, manifest, or backend/connector JSDoc.

Expected files are
`tests/performance/quick-session/hostPrewarmComparison.real.test.ts`,
`tests/performance/quick-session/compiled-host-observer-cross-process.real.json`,
`package.json`, `tests/README.md`, and this ledger. A new opt-in ten-run mode
keeps the BENCH-035-P current compiled, PTY-used, empty Host in the benchmark
parent but launches the real compiled `__observer` route as a child with the
real 49-worktree config. The parent timestamps intent at its first healthy
startup response and immediately performs one controller ensure and the same
strict new PTY interaction.

The exact 50/100ms intent, 10ms readiness-to-ensure-start, 25ms ensure, and
1500ms Observer-startup thresholds are registered in the table. Current child
build/identity, healthy ready snapshot with 49 worktrees, live warm Host, setup
and measured immutable PTY identity/input, empty inventories, protocol stop,
zero child exit, empty child/Host stderr, and every root removal are mandatory.
Any process, safety, timing-coherence, or cleanup failure rejects cross-process
latency interpretation.

Outcome: the cross-process hypothesis and both interactive predictions passed,
but the registered experiment is rejected by its independent Observer-startup
tail rule. Intent-to-input-ack median/p95 was 12.5/40.6ms;
readiness-to-ensure-start was 0.004/0.020ms and measured ensure was 2.0/4.5ms.
Attach-to-ready supplied the largest interactive p95 at 23.1ms, while every
other post-ensure phase stayed at or below 10.3ms. Observer startup was
814/1853ms median/p95, with four of ten samples above the fixed 1500ms gate.
All ten current compiled child identities, healthy responses, exact
49-worktree snapshots, live PTY-used Hosts, immutable PTY identities, input
acknowledgements, empty inventories, protocol stops, zero exits, empty stderr,
timing sums, and root removals passed. This validates that BENCH-035-P's
145–269ms pre-call gap was an in-process harness artifact; it does not authorize
advancement under a weakened startup rule.

## BENCH-037-U registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/configuration.md`, `docs/harness-signals.md`, `docs/development.md`,
`tests/README.md`, EXP-010, EXP-015, BENCH-016-E, BENCH-017-A, and
BENCH-036-X. This is a product-boundary diagnostic and changes no production
CLI, TUI, dashboard state, Observer, Host, provider, protocol, contract,
configuration, architecture, manifest, or backend/connector JSDoc.

Expected files are
`tests/performance/quick-session/compiledQuickSessionTui.real.test.ts`,
`tests/performance/quick-session/compiled-quick-session-tui.real.json`,
`package.json`, `tests/README.md`, and this ledger. A new opt-in five-run lane
will build the current all-in-one binary outside timing, shape one repository to
49 registered worktrees, and keep one exact current Host alive after a strict
setup PTY lifecycle. Each repetition stops Observer, launches bare compiled
`stn` through a real attached PTY, waits for the native dashboard, activates
the focused Project Quick Session control, and records raw intent through
optimistic UI, Observer command evidence, worktree publication, Host child
readiness/input acknowledgement, canonical UI convergence, and pane focus.

The exact 1500/2500ms CLI-launch, 50ms optimistic, 100/200ms interactive,
350ms canonical-UI, and 2700ms full-launch p95 rules are registered in the
table. Current compiled CLI/Observer/Host identity, exact starting and cleanup
inventories, one unique command/trace and worktree, correct repository/path/
branch/harness/terminal binding, immutable PTY identity, readiness and input,
canonical row with no optimistic activity, actual focus, clean process stops,
empty stderr, and removal of all roots are mandatory. Build, repository shape,
Host seed, and between-run Git cleanup are setup evidence outside the measured
windows. Any unsafe, missing-stage, process, or cleanup result rejects the
diagnostic; startup is never subtracted from the separately reported full path.

Outcome: the full product boundary is materially slower than its internal
pieces and BENCH-037-U is rejected. CLI launch-to-dashboard median/p95 was
1900/2091ms. Intent-to-optimistic UI was 9.6/10.3ms, command completion was
82.6/93.1ms, Host readiness was 127.5/255.4ms, and canonical UI convergence was
168.0/282.9ms. The exact queued pane did not acknowledge real focused input
until 715/819ms, making full launch-to-interactive 2701/2903ms. The registered
startup median, interactive median/p95, and full-path p95 gates failed.

All five runs used current compiled CLI/Observer/Host identity and began and
ended at exactly 49 worktrees. Unique command/trace, worktree, session, Host
PTY, scripted harness, Station terminal, readiness, controller input, canonical
UI, actual focus, Git/Host cleanup, UI/Observer/Host stop, Host stderr, and root
checks passed. The literal empty UI-stderr gate failed because each valid CLI
launch intentionally printed exactly `Launching STATION TUI…\n`; the failure is
retained rather than silently reclassified.

## BENCH-038-F registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/configuration.md`, `docs/harness-signals.md`, `docs/development.md`,
`tests/README.md`, EXP-010, EXP-015, BENCH-036-X, and BENCH-037-U. This is a
native-input attribution diagnostic and changes no production input protocol,
keymap, Quick Session behavior, dashboard dismissal, pane focus, Observer,
Host, provider, contract, configuration, architecture, manifest, or backend/
connector JSDoc.

Expected files are
`tests/performance/quick-session/compiledQuickSessionTui.real.test.ts`,
`tests/performance/quick-session/compiled-quick-session-focus.real.json`,
`package.json`, `tests/README.md`, and this ledger. A new opt-in ten-run mode
will alternate the existing raw Escape dashboard dismissal with the existing
Ctrl-O overlay toggle after identical canonical Quick Session convergence. It
adds adjacent monotonic timestamps at focus gesture, overlay disappearance,
input write, and Host acknowledgement. Repository shape, current compiled
binary, ordinary Observer restart, preserved PTY-used Host, real PTY input,
and every pre-focus stage remain identical.

The exact 100ms Ctrl-O focus-to-ack, 75% same-window improvement, 250/350ms
intent-to-interactive, coherent-phase, and ten-safe-run rules are registered in
the table. Every BENCH-037 identity, command/trace, repository, Host/PTTY,
canonical UI, focus/input, cleanup, shutdown, and root invariant remains
mandatory. UI stderr must equal the single known progress line and Host stderr
must be empty. Any semantic mismatch, extra stderr, phase incoherence, or
safety failure rejects attribution; this diagnostic alone authorizes no
automatic dashboard dismissal.

Outcome: the Escape attribution is strong but the registered experiment is
rejected. Escape→Ctrl-O focus-to-input-ack median/p95 was
542/600→33/165ms, while focus→overlay-dismissal was 534/582→21/24ms.
Intent-to-interactive moved from 794/846 to 213/634ms. Ctrl-O therefore removed
the deterministic Escape wait, but one 148ms input-write-to-acknowledgement
outlier missed the 100ms focus p95, reduced p95 improvement to 72.6% versus the
75% rule, and missed the 350ms intent p95. All phase sums were coherent.

All ten runs reached their exact canonical session, immutable Host PTY ready
marker, input acknowledgement, zero Host inventory, 49-worktree Git cleanup,
and clean UI/Observer stops. One run legitimately emitted both Observer-start
and TUI-launch progress lines because Observer startup was required. The
artifact's aggregate `safe` field was false for every run, but it did not retain
the individual predicate values needed to distinguish its additional benchmark
expectation mismatch. BENCH-039-S will audit that reporting defect; it cannot
retroactively change BENCH-038-F's timing rejection.

## BENCH-039-S registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/configuration.md`, `docs/harness-signals.md`, `docs/development.md`,
`tests/README.md`, BENCH-037-U, and BENCH-038-F. This is correctness-reporting
instrumentation only and changes no production Quick Session, dashboard, input,
Observer, Host, provider, protocol, contract, configuration, architecture,
manifest, or backend/connector JSDoc.

Expected files are
`tests/performance/quick-session/compiledQuickSessionTui.real.test.ts`,
`tests/performance/quick-session/compiled-quick-session-safety.real.json`,
`package.json`, `tests/README.md`, and this ledger. A one-run opt-in mode will
retain a named boolean for every existing product-boundary predicate and use the
faster existing Ctrl-O gesture. It changes no order, wait, identity, cleanup, or
performance threshold.

Every command/trace, project, branch/path/registration, harness/terminal,
session/PTTY, ready/input, canonical UI, Host/Git inventory, process-stop,
stderr, phase-coherence, and root-removal predicate must be explicit in the
artifact. Accept the audit only if exactly one or more named false predicates
fully explain `safe=false`, awaited identity/input and cleanup predicates remain
true, and all roots are removed. Prediction: a benchmark expectation—not
session identity, input acknowledgement, or cleanup—is false. This diagnostic
cannot advance a latency or production-behavior claim.

Outcome: accepted exactly as predicted. The sole false predicate was
`sessionTerminalMatches`: the benchmark expected the literal provider
`station`, but Station Host's provider-neutral contract ID is `native`. The
other 18 named predicates passed, including exact command/project/harness,
worktree path and registration identity, canonical scripted session, Host
worktree/session binding, readiness and input acknowledgement, empty Host
inventory, 49-worktree Git restoration, UI/Observer stop, exact single progress
line, phase coherence, and both root removals. The diagnostic run reached
canonical UI in 314ms, Ctrl-O focus-to-ack in 97ms, and intent-to-interactive in
410ms; those one-run values carry no latency decision. The benchmark now uses
`STATION_HOST_PROVIDER_ID`. This correctness fix does not alter BENCH-038-F's
mechanical timing rejection.

## EXP-016 preregistered change plan

Governing sources are `docs/architecture.md`, `docs/tui.md`,
`tests/README.md`, the original
`/Users/jeremyodell/Documents/station-session-start-performance-experiment.md`
protocol, and BENCH-037-U through BENCH-039-S above. The native workspace owns
overlay and pane focus; dashboard-core continues to own provider-neutral Quick
Session orchestration. The invariant is that the native dashboard may dismiss
itself only after the requested Quick Session has actually opened, revealed, or
focused its managed pane. A notice, worktree failure, launch failure, duplicate
non-landing result, deliberate New Session, or Fork must leave the dashboard
visible and actionable. Closing the overlay must land on the exact pane already
recorded as its return target, while Group Quick Session correlation and
membership settlement continue after the surface is hidden.

The blind prediction and mechanical decision rules are fixed in the EXP-016
table row before either the control binary or candidate implementation is
built. Ten current-code Ctrl-O runs and ten candidate automatic-dismissal runs
will use the same 49-worktree shape, compiled CLI boundary, PTY-used current
Host, ordinary Observer restart, raw Quick Session pointer intent, exact Host
ready/input markers, and cleanup. Control input sends Ctrl-O after canonical
convergence. Candidate input sends no dismissal key and waits for the overlay
to disappear as a consequence of successful Quick Session execution. Raw
artifacts must retain the named BENCH-039 predicates plus the selected arm,
binary/build identity, all stage timestamps, whether any dismissal byte was
sent, machine load, resource deltas, and cleanup evidence.

Expected retained files if the candidate wins are:

- native composition: `station/src/app/dashboardCapabilities.ts`;
- native managed-launch boundary: `station/src/input/runtime/managedLaunch.ts`;
- source-adjacent coverage: `station/src/app/dashboardCapabilities.test.ts` and
  `station/src/input/runtime/managedLaunch.test.ts`;
- behavior documentation: `docs/tui.md`;
- experiment record and summary:
  `tests/performance/quick-session/ledger.md` and
  `tests/performance/quick-session/report.md`.

The one-off product runner
`tests/performance/quick-session/compiledQuickSessionTui.real.test.ts` and its
generated control/candidate JSON under `.dev-state/performance/quick-session/`
are measurement evidence, not review-branch product files; after a decision
they will be removed from this branch and preserved only on the evidence archive
or a new continuation archive. No package script, contract, protocol, Observer,
provider, connector, configuration, architecture manifest, or dashboard-core
surface is expected to change.

JSDoc impact is explicit: add documentation for the native
`ManagedHostedSessionRequest` foreground/background choice and update the
`createManagedLaunch` boundary documentation to state that callers select
whether a successful placement lands in the pane. No backend or connector
JSDoc changes are expected. If the candidate loses any timing or correctness
gate, restore both production modules, both source-adjacent test files,
`docs/tui.md`, and the report exactly, retain only this rejected ledger outcome,
and archive the raw comparison.

Outcome: rejected mechanically and reverted. The ten-run fresh Ctrl-O control
passed every named safety predicate at 220/2348ms median/p95
intent-to-interactive. The ten-run automatic candidate also passed every named
safety predicate and sent no dismissal input byte, at 196/358ms. That is an 11%
median improvement and an 84.8% p95 improvement, but the candidate missed the
fixed 350ms absolute p95 by 7.8ms and its 300ms prediction by 58ms. More
importantly, overlay-dismissal-to-input-ack p95 was 154ms against the fixed
100ms rule. The outlier decomposed into bounded automatic dismissal followed by
the still-unready Host child; input-write-to-ack p95 itself was 54ms.

All twenty runs preserved exact command/trace, Project, branch/path/
registration, scripted harness, provider-neutral native terminal, canonical
session, immutable Host PTY, ready/input, inventory, process-stop, accepted
progress-stderr, phase-coherence, and root-removal evidence. Focused source tests
also passed for landed success, non-landing success, notice, launch failure,
deliberate Create, Fork, canonical continuation, and exact foreground/background
propagation, and Station typecheck passed. Those correctness results cannot
override either failed timing rule. The production, source-adjacent test, JSDoc,
and `docs/tui.md` candidate edits were restored; the one-off runner and raw JSON
are retained only on the continuation evidence archive.

## BENCH-040-I registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`, `docs/tui.md`,
`tests/README.md`, the original experiment protocol, and EXP-016. The raw
EXP-016 candidate artifact is the runtime evidence: repetition zero dismissed
at 203ms, waited until the harness-ready marker at 304ms, wrote at 304ms, and
received acknowledgement at 358ms. The other nine runs reached harness readiness
before automatic dismissal and wrote within 0.01ms afterward. This diagnostic
tests whether the exceptional 100ms interval is required for input safety or is
serialization introduced by the one-off runner.

The exact rejected candidate binary remains locally available at
`station/dist/bin/stn` with embedded Observer build identity
`0.0.0-pre-alpha.5.16+station.35acc427d7a27d641d8b0295a07faf73e78270230eed4fff0d19e0ab3f9fa744`.
BENCH-040-I must verify that identity before running and must not rebuild it from
the reverted source tree. On each of ten repetitions, the runner will arm raw
overlay-disappearance observation at Quick Session intent, write the unique
input token immediately after disappearance, and independently observe the
Host ready marker and acknowledgement. It will then reopen the dashboard to
verify canonical convergence before exact removal and shutdown.

Expected files are the ignored one-off runner
`tests/performance/quick-session/compiledQuickSessionTui.real.test.ts`, raw
`.dev-state/performance/quick-session/bench-040-immediate-input.real.json`, and
this ledger. The runner and raw JSON will be added only to the continuation
archive after classification. No production, test, package, contract, protocol,
Observer, Host, provider, connector, configuration, architecture, report, or
JSDoc file changes. The table row fixes every timing and correctness rule before
the diagnostic. Acceptance establishes only that focused Host PTY input can be
buffered before the harness-ready marker in this boundary; rejection leaves the
EXP-016 conclusion and next question unchanged.

Outcome: rejected mechanically, while the narrower input-buffering prediction
was proved. All ten runs wrote within 0.064ms of automatic overlay dismissal
and the immutable PTY acknowledged each unique token exactly once. In the live
non-replay sample, input was written 115ms before the scripted harness-ready
marker and acknowledged 118ms after focus without loss or duplication.
Dismissal-to-ack therefore passed its 120ms p95 rule at 118ms, and all other
focus-to-ack samples were at most 33.5ms.

Intent-to-interactive was 184/349ms median/p95. The median passed 200ms, but the
p95 missed 320ms by 29ms, improved only 2.4% from EXP-016's 358ms rather than
the required 10%, and missed the 310ms prediction by 39ms. The 349ms sample
spent 317ms reaching foreground focus and only 32ms from focus through exact
acknowledgement; its command had completed at 181ms and Host readiness arrived
at 266ms. The next target is therefore the successful managed-launch interval
before foreground focus, not a readiness wait after the pane is accepting
input. Every named command, project, worktree, scripted harness, session/PTTY,
ready/input, canonical, inventory, process-stop, accepted progress-stderr,
phase-coherence, and root-removal predicate passed. This diagnostic changes no
production source and cannot alter EXP-016's rejection.

## BENCH-041-P registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`, `docs/tui.md`,
`tests/README.md`, the original experiment protocol, EXP-016, and BENCH-040-I.
The runtime artifact is authoritative: BENCH-040 repetition eight completed
the Observer worktree command at 181ms, observed Host readiness at 266ms,
foregrounded the pane at 317ms, and acknowledged immediate input at 349ms.
Because focus-to-ack was only 32ms, this diagnostic divides the 136ms internal
command-completion-to-focus interval before proposing another behavior change.

The diagnostic will rebuild the same candidate semantics EXP-016 already
proved in focused tests: Quick Session alone requests a foreground managed
launch, and the native overlay closes only after `{ kind: "success", landed:
true }`; deliberate Create, Fork, non-landing success, notices, and failures stay
background/visible. BENCH-040's corrected immediate-input observation remains
the interaction boundary. No candidate behavior or timing optimization is
being evaluated for retention in BENCH-041.

An opt-in temporary recorder will add monotonic in-memory marks for hosted
launch start, command completion, canonical worktree observation, managed
attempt start/preflight, `prepareExternalLaunch` request/response, managed Host
attachment resolution, terminal placement, pane publication, attempt
settlement, Quick result receipt, and overlay-close request. It may append only
to memory before interaction and must emit exactly one structured trace line at
UI process exit; any earlier diagnostic I/O invalidates the run. Twenty fresh
compiled product repetitions will parse that line alongside the existing outer
Quick Session timestamps.

Expected temporary source files are
`station/src/app/dashboardCapabilities.ts`,
`station/src/input/runtime/managedLaunch.ts`,
`station/src/input/runtime/managedLaunchAttempt.ts`, and a narrowly owned
`station/src/input/runtime/managedLaunchPhaseDiagnostic.ts`. Expected temporary
source-adjacent coverage is
`station/src/app/dashboardCapabilities.test.ts` and
`station/src/input/runtime/managedLaunch.test.ts`. The one-off runner is
`tests/performance/quick-session/compiledQuickSessionTui.real.test.ts`; raw JSON,
an archive summary, and this ledger are the only evidence artifacts. No package,
contract, protocol, Observer, Host, provider, connector, configuration,
architecture, permanent test, report, or user documentation changes are
expected.

JSDoc impact is explicit: the temporary phase-recorder module will document its
exit-only diagnostic contract, and the temporary `ManagedHostedSessionRequest`
foreground/background option and managed-launch boundary documentation will
match EXP-016. No backend or connector JSDoc changes are expected. After the
diagnostic, all candidate behavior, instrumentation, source-adjacent tests, and
JSDoc will be reverted; only the ledger stays on the review branch, while the
runner, raw result, summary, and temporary source diff stay on a continuation
archive.

The table row fixes attribution mechanically before those edits. Every required
mark must occur exactly once in the registered order and adjacent durations
must sum exactly to the internal command-completion-to-overlay-close interval.
At least two such intervals must exceed 75ms. A phase is dominant only if it
supplies at least 60% of total p95 and at least half of each of at least two
over-75ms samples. User-facing p95 must remain at most 380ms, attachment
resolution p95 at most 25ms, and every BENCH-040 safety predicate must pass.
Prediction: `prepareExternalLaunch` supplies at least 70% of total p95 and at
least half of every over-75ms interval, while attachment-resolution p95 is at
most 10ms. Failure to meet any attribution rule is a rejection, not permission
to choose the most plausible phase.

Outcome: accepted for phase attribution, with the blind prediction partly
disproved. All twenty required marker arrays were exact, monotonic, phase-sum
coherent, and absent from stderr until normal UI exit. Internal command
completion to overlay-close request was 52/81ms median/p95. Observer
`prepareExternalLaunch` was the dominant segment at 31/60ms and supplied 73.9%
of total p95. Four intervals exceeded 75ms; preparation supplied at least half
of three, satisfying the registered two-tail attribution rule. The fourth was
48.4% preparation because attachment resolution expanded to 29.5ms.

Attachment resolution measured 13/24.982ms and therefore passed its 25ms
attribution guard by only 0.018ms, while disproving the predicted 10ms bound.
The prediction that preparation would dominate every over-75ms interval also
failed. Other p95 contributions were 9.64ms from pane publication through
attempt completion, 0.66ms from resolved attachment to terminal placement, and
at most 0.51ms for every other segment. User-facing intent-to-exact-input-
acknowledgement p95 was 344.703ms, below the registered 380ms diagnostic guard;
focus-to-ack p95 was 56.376ms.

Every repetition retained exact command/trace, Project, branch/path/
registration, scripted harness, provider-neutral native terminal,
session/PTTY, ready and exact-once immediate input, canonical UI, Host/Git
inventory, process-stop, accepted progress-stderr, outer phase, and root
evidence. The temporary foreground/automatic-dismissal candidate,
instrumentation, source-adjacent tests, and JSDoc must still be reverted because
BENCH-041 authorizes attribution only. The next diagnostic must divide Observer
launch preparation across mutation admission, managed-target inventory,
persistence, managed workspace opening, harness-plan construction, Host process
launch, and narrow canonical projection before selecting production work.

## BENCH-042-O registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, the original experiment protocol, and BENCH-041-P. The
accepted runtime evidence is authoritative: client-visible
`prepareExternalLaunch` was 31/60ms median/p95, supplied 73.9% of the internal
command-completion-to-focus p95, and dominated three of four intervals over
75ms. Host attachment resolution was separately 13/24.982ms.

BENCH-042 retains the exact temporary BENCH-041 foreground, automatic-close,
immediate-input, UI phase-recorder, and twenty-repetition product boundary. It
adds an Observer-owned diagnostic recorder and marks entry into
`prepareExternalLaunch`, worktree-mutation admission, managed-target inventory,
harness preflight, fresh-session persistence, managed workspace opening,
harness launch-plan construction, Host managed-process launch, narrow canonical
projection, and successful return. Marks remain in memory. The Observer writes
one strict JSON artifact to the repetition-specific temporary path only in its
normal process-exit handler, after the runner has proved the file absent before
Observer stop.

Expected temporary files from BENCH-041 are
`station/src/app/dashboardCapabilities.ts`,
`station/src/app/dashboardCapabilities.test.ts`,
`station/src/input/runtime/managedLaunch.ts`,
`station/src/input/runtime/managedLaunch.test.ts`,
`station/src/input/runtime/managedLaunchAttempt.ts`,
`station/src/input/runtime/managedLaunchPhaseDiagnostic.ts`, and
`tests/performance/quick-session/compiledQuickSessionTui.real.test.ts`.
BENCH-042 additionally changes `apps/observer/src/runtime/externalLaunch.ts` and
adds `apps/observer/src/runtime/externalLaunchPhaseDiagnostic.ts`. Raw JSON, a
standalone archive summary, and this ledger are the evidence artifacts. No
package, contract, protocol, provider, connector, configuration, architecture,
permanent test, report, or user-documentation change is expected.

JSDoc impact is explicit: the temporary Observer recorder documents its
exit-only, no-pre-interaction-I/O contract. BENCH-041's temporary request and UI
recorder JSDoc remains unchanged. No retained backend or connector JSDoc change
is expected, because all instrumentation and foreground behavior will be
reverted after classification.

The table row fixes the decision before restoring or editing diagnostic source.
All required Observer markers must occur exactly once and monotonically; their
adjacent durations must sum within 0.1ms of Observer entry-to-return. The p95 of
client RPC duration minus Observer internal duration must be nonnegative and at
most 15ms. At least two internal preparations must exceed 40ms. A subphase is
dominant only if it supplies at least 50% of internal p95 and at least half of
at least two over-40ms samples. User-facing p95 remains bounded at 380ms and
attachment-resolution p95 at 30ms. Prediction: Host managed-process launch
supplies at least 60% of internal p95 and at least half of every over-40ms
sample; managed-target inventory and persistence p95 are each at most 10ms,
narrow canonical projection p95 at most 5ms, and transport residual p95 at most
10ms. Any failed condition rejects attribution mechanically.

Outcome: rejected mechanically after one exact diagnostic-witness correction.
The authoritative twenty-run attempt passed every product and trace-safety
predicate. User intent to exact input acknowledgement was 224/345ms
median/p95; client-visible preparation was 33/46ms, Observer-internal
preparation 16/23ms, client-minus-Observer residual 18/24ms, and attachment
resolution 12/18.729ms. Host process launch was the largest Observer subphase
at 11/18.799ms and supplied 80.9% of internal p95, but none of the twenty
internal preparations exceeded the required 40ms tail boundary. The residual
also missed the 15ms attribution guard and 10ms prediction.

The first attempt proved that the TUI process loaded the shared Observer module
and wrote an empty artifact before Observer stop. Reversing teardown in a
second attempt let that empty artifact overwrite the valid Observer trace.
Restricting exit output to a process that recorded at least one marker repaired
only the diagnostic witness; normal teardown and every registered threshold
remained fixed. Both invalid raw attempts and the authoritative result are on
the BENCH-042 continuation archive. All temporary behavior and instrumentation
were reverted from the review branch.

## BENCH-043-T registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, the original experiment protocol, BENCH-041-P, and
BENCH-042-O. Current source is also authoritative: each non-health operation in
`packages/protocol/src/client.ts` opens a fresh Unix socket and performs an
expected-build `observer.health` request before sending the requested method on
that same connection. BENCH-042 measured the whole unassigned client/Observer
residual at 18/24.070ms median/p95.

BENCH-043 retains the exact temporary BENCH-042 foreground, automatic-close,
immediate-input, UI phase trace, Observer internal phase trace, twenty fresh
compiled repetitions, and full correctness matrix. It adds a protocol-owned
in-memory diagnostic with client marks at protocol entry, runtime-boundary task
entry, socket-connect start/completion, expected-build health start/completion,
actual prepare request start/response completion, boundary completion, and
protocol return. Server marks cover parsed prepare request, handler admission,
use-case dispatch start/completion, and response send. Separate strict client
and server artifacts are written only by a process that recorded those marks,
and only at normal process exit.

Expected temporary files inherited from BENCH-042 are
`station/src/app/dashboardCapabilities.ts`,
`station/src/app/dashboardCapabilities.test.ts`,
`station/src/input/runtime/managedLaunch.ts`,
`station/src/input/runtime/managedLaunch.test.ts`,
`station/src/input/runtime/managedLaunchAttempt.ts`,
`station/src/input/runtime/managedLaunchPhaseDiagnostic.ts`,
`apps/observer/src/runtime/externalLaunch.ts`,
`apps/observer/src/runtime/externalLaunchPhaseDiagnostic.ts`, and
`tests/performance/quick-session/compiledQuickSessionTui.real.test.ts`.
BENCH-043 additionally changes `packages/protocol/src/client.ts` and
`packages/protocol/src/server.ts`, and adds
`packages/protocol/src/prepareExternalLaunchPhaseDiagnostic.ts`. Raw JSON, a
standalone archive summary, and this ledger are the evidence artifacts. No
package manifest, shared contract or schema, provider, connector,
configuration, architecture, permanent test, report, or user-documentation
change is expected.

JSDoc impact is explicit: the temporary protocol recorder documents its
exit-only, no-pre-interaction-I/O and nonempty-owner contracts. Existing
temporary UI and Observer recorder JSDoc remains unchanged. No retained
backend, connector, or protocol JSDoc change is expected because all diagnostic
source will be reverted after classification.

The table row freezes the decision before any diagnostic source is restored.
All UI, client, server, and Observer marks must occur exactly once and
monotonically. Client and server adjacent phases must sum within 0.1ms of their
respective outer intervals; the reconstructed residual must match the existing
client-minus-Observer value within 1ms in every run. At least two residuals must
exceed 20ms. A named residual phase is dominant only if it supplies at least
40% of residual p95 and at least half of at least two over-20ms residuals.
User-facing p95 stays bounded at 380ms, attachment p95 at 30ms, and total
residual p95 at 35ms. Prediction: expected-build health validation supplies at
least 50% of residual p95 and at least half of every over-20ms residual; socket
connect, actual-request wire/client work, Observer pre-use-case dispatch, and
Observer post-use-case response p95 are each at most 5ms; combined outer client
settlement p95 is at most 3ms. Failure of any condition rejects attribution.

Validation before the product run will include Protocol, Observer, and Station
typechecks; `packages/protocol/test/integration/client-server.test.ts`,
`apps/observer/test/unit/external-launch.test.ts`, the focused temporary
dashboard/managed-launch tests, Biome, `git diff --check`, and the one-off
runner's skipped-mode Vitest compile. No production optimization is registered
until BENCH-043 identifies a mechanically accepted residual owner.

Outcome: rejected mechanically. The authoritative twenty-run attempt produced
exact, monotonic, exit-only UI, client, server, and Observer traces; every
residual reconstruction error was exactly zero and every product-safety
predicate passed. Residual measured 17.601/76.251ms median/p95, above its 35ms
guard, while intent-to-exact-input acknowledgement was 222/853.612ms, above its
380ms guard. Attachment resolution remained 11.009/18.785ms.

Actual-request wire/client work was the descriptive dominant segment at
9.105/48.862ms, supplied 64.1% of residual p95, and supplied at least half of
three of nine residuals over 20ms. Expected-build health validation measured
4.180/24.603ms, supplied only 32.3% of residual p95, and supplied less than half
of every tail, disproving the blind prediction. Socket connect was
0.504/2.113ms, Observer pre-use-case dispatch 0.846/1.221ms, Observer post-use-
case response 2.441/5.840ms, and combined outer client settlement
0.386/0.992ms. Thus the named-phase dominance condition passed, but the run was
too perturbed to authorize that attribution.

The first attempt stopped after three individually safe runs when a later TUI
presented a blank startup frame. Read-only process evidence found seven
parentless `stn __tui` processes from exact `st-qtu-*` roots in this worktree;
they were terminated before the authoritative attempt, and no other worktree or
named tmux session was touched. The valid run still observed one-minute load
between 16.0 and 23.4 on ten logical CPUs, with user-facing p95 tails up to
2.280s. Both raw attempts are retained. All temporary behavior and
instrumentation must be reverted from the review branch.

## BENCH-044-W registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, the original experiment protocol, BENCH-042-O, and
BENCH-043-T. BENCH-043 is authoritative only as a rejection: actual-request
wire/client work was descriptively largest at 9.105/48.862ms median/p95, but
total residual and user p95 missed fixed perturbation guards under elevated
scheduler preemption. Load average alone does not explain stability because
BENCH-041/042 remained bounded at overlapping one-minute loads.

BENCH-044 retains the exact temporary foreground, automatic-close,
immediate-input, UI/client/server/Observer traces, twenty-repetition compiled
product boundary, and full correctness matrix. Before each repetition begins,
the runner executes fifty `setImmediate` turns and ten sequential
`/usr/bin/true` processes. It records every admission attempt and waits one
second between failures, admitting only when event-loop p95 is at most 1ms and
process-spawn p95 at most 5ms; failure to admit within 300s rejects the attempt.
No timing sample is discarded or filtered after its product repetition starts.

Protocol marks gain comparable `performance.timeOrigin + performance.now()`
timestamps. Client marks divide prepare-request construction, send, response-
frame receipt, envelope validation, result validation, and settlement. Server
marks identify expected-health request receipt/response send, prepare request
receipt, response construction, and response send. The runner reconstructs the
health round trip, actual prepare round trip, BENCH-043 wire/client remainder,
and whole residual independently. Negative cross-process ordering or more than
1ms error at any reconstruction invalidates the run.

Expected temporary files inherited from BENCH-043 are
`station/src/app/dashboardCapabilities.ts`,
`station/src/app/dashboardCapabilities.test.ts`,
`station/src/input/runtime/managedLaunch.ts`,
`station/src/input/runtime/managedLaunch.test.ts`,
`station/src/input/runtime/managedLaunchAttempt.ts`,
`station/src/input/runtime/managedLaunchPhaseDiagnostic.ts`,
`apps/observer/src/runtime/externalLaunch.ts`,
`apps/observer/src/runtime/externalLaunchPhaseDiagnostic.ts`,
`packages/protocol/src/client.ts`, `packages/protocol/src/server.ts`,
`packages/protocol/src/prepareExternalLaunchPhaseDiagnostic.ts`, and
`tests/performance/quick-session/compiledQuickSessionTui.real.test.ts`.
BENCH-044 changes only those last four protocol/runner files beyond the archived
BENCH-043 state. Raw JSON, a standalone archive summary, and this ledger are the
evidence artifacts. No package manifest, shared contract/schema, provider,
connector, configuration, architecture, permanent test, report, or user-
documentation change is expected.

JSDoc impact is explicit: the temporary protocol recorder documentation will
add its cross-process comparable-clock contract. Existing temporary UI and
Observer recorder JSDoc remains unchanged. No retained backend, connector, or
protocol JSDoc change is expected because all instrumentation will be reverted
after classification.

The table row freezes the decision before restoring diagnostic source. All
twenty repetitions must pass admission and every BENCH-043 safety predicate.
All trace orders and adjacent phase sums remain exact; health, actual-request,
wire/client, and full-residual reconstructions must be nonnegative and within
1ms. At least two wire/client intervals must exceed 10ms. A phase is dominant
only if it supplies at least 50% of wire/client p95 and at least half of at least
two over-10ms intervals. User-facing p95 remains bounded at 380ms, attachment
p95 at 30ms, and residual p95 at 35ms. Prediction: client response-frame-to-
result validation supplies at least 50% of wire/client p95 and at least half of
every tail; request construction/send p95 is at most 2ms, ingress and egress
scheduling p95 each at most 5ms, expected-health p95 at most 10ms, and server
response construction/send p95 at most 5ms. Any failed condition rejects
attribution mechanically.

Validation before the product run will repeat Protocol, Observer, and Station
typechecks; Protocol client/server integration, Observer external-launch unit,
focused temporary dashboard/managed-launch tests, Biome, `git diff --check`, and
the runner's skipped-mode compile. No production optimization is registered
until BENCH-044 passes every stability, attribution, and product guard.

Outcome: rejected mechanically. The corrected authoritative attempt admitted
all twenty product repetitions in twenty-five stability attempts and passed
every product, trace, reconstruction, and perturbation guard. Intent-to-exact-
input acknowledgement measured 174.134/294.324ms median/p95, attachment
8.166/18.173ms, and client-minus-Observer residual 13.699/20.016ms. The actual-
request wire/client remainder measured 6.832/11.093ms.

Server-send-to-client-frame egress scheduling was descriptively dominant at
5.902/8.708ms, supplied 78.5% of wire/client p95, and supplied at least half of
all five intervals over 10ms. Client frame-to-result validation measured only
0.402/0.560ms, supplied 5.0% of p95, and supplied 3.2-5.4% of every tail,
disproving the frozen blind prediction. Request construction/send measured
0.292/0.644ms and 0.019/0.031ms; ingress scheduling 0.154/1.497ms; expected-
health 2.147/4.539ms; server response construction/send 0.392/0.731ms and
0.014/0.021ms. Full residual reconstruction error was zero and the maximum
cross-clock error was 0.000212ms.

The first twenty-run attempt is invalid and retained separately because its
server recorder captured health exchanges from unrelated Observer connections.
The corrected recorder committed only the health exchange on the same socket
immediately preceding prepare; Protocol typecheck and all 43 integration tests
passed before the authoritative rerun. All temporary behavior and diagnostics
must be reverted from the review branch. Next register an exit-only transport
diagnostic that separates socket arrival, frame parsing, queue publication, and
async-iterator resumption; do not optimize the transport from this descriptive
result alone.

## BENCH-045-D registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, the original experiment protocol, BENCH-043-T, and
BENCH-044-W. BENCH-044 is authoritative only as a rejection: under valid
stability and perturbation guards, server-send-to-client-frame egress supplied
78.5% of actual-request wire/client p95 and dominated all five tails, while the
frozen client-validation prediction was false. The source audit shows the real
NDJSON connection parses socket `data` frames into a queue, resolves blocked
waiters, resumes an async generator, dequeues, yields, and only then resolves
the client's `iterator.next()`.

BENCH-045 retains BENCH-044's exact temporary launch behavior, four trace
layers, twenty-repetition compiled product boundary, full correctness matrix,
and per-repetition stability admission. It adds exit-only client-transport
marks for response-diagnostic arming, iterator wait, socket-data callback,
newline extraction, JSON parse, queue publication, waiter resolution, iterator
resumption, dequeue, generator yield, and the existing outer frame receipt.
The diagnostic is armed only after the same connection's expected-health check
and immediately before sending `agent.prepareExternalLaunch`; other protocol
traffic and in-memory connections remain unrecorded. Comparable epoch and
process-local timestamps reconstruct the BENCH-044 response-egress interval
without reading or interpreting untrusted response fields in the transport.

Expected temporary files inherited from BENCH-044 are
`station/src/app/dashboardCapabilities.ts`,
`station/src/app/dashboardCapabilities.test.ts`,
`station/src/input/runtime/managedLaunch.ts`,
`station/src/input/runtime/managedLaunch.test.ts`,
`station/src/input/runtime/managedLaunchAttempt.ts`,
`station/src/input/runtime/managedLaunchPhaseDiagnostic.ts`,
`apps/observer/src/runtime/externalLaunch.ts`,
`apps/observer/src/runtime/externalLaunchPhaseDiagnostic.ts`,
`packages/protocol/src/client.ts`, `packages/protocol/src/server.ts`,
`packages/protocol/src/prepareExternalLaunchPhaseDiagnostic.ts`, and
`tests/performance/quick-session/compiledQuickSessionTui.real.test.ts`.
BENCH-045 additionally changes `packages/protocol/src/transport.ts`. The
focused transport unit test is validation-only unless the diagnostic requires
a temporary exact-order regression. Raw JSON, a standalone archive summary,
and this ledger are the evidence artifacts. No package manifest, shared
contract/schema, provider, connector, configuration, architecture, permanent
test, report, or user-documentation change is expected.

JSDoc impact is explicit: the temporary connection diagnostic method documents
that it arms only the next real-socket response and has no transport behavior
authority. The temporary protocol recorder documents the transport phase
ownership contract. No retained backend, connector, or protocol JSDoc change
is expected because all instrumentation will be reverted after classification.

The table row freezes the decision before diagnostic source is restored. All
twenty repetitions must pass BENCH-044 admission and every product predicate.
The transport trace must be exact, monotonic, absent before UI exit, and
nonnegative across processes; its adjacent phases must reconstruct the existing
server-send-to-client-frame interval within 1ms in every run. At least two
response-egress intervals must exceed 6ms. A stage is dominant only if it
supplies at least 60% of response-egress p95 and at least half of at least two
over-6ms intervals. User-facing p95 remains bounded at 380ms, attachment p95 at
30ms, residual p95 at 35ms, and response-egress p95 at 15ms. Prediction: time
from server send return to client socket-data callback supplies at least 70% of
response-egress p95 and at least half of every tail; callback entry through
queue publication, waiter resolution through iterator resumption, dequeue,
generator yield, and outer continuation each have p95 at most 1ms, and their
combined post-callback work has p95 at most 2ms. Any failed condition rejects
attribution mechanically.

Validation before the product run will repeat Protocol, Observer, and Station
typechecks; Protocol transport unit and client/server integration tests,
Observer external-launch unit, focused temporary dashboard/managed-launch
tests, Biome, `git diff --check`, and the runner's skipped-mode compile. No
production optimization is registered until BENCH-045 passes every stability,
attribution, and product guard.

Outcome: accepted attribution. All twenty authoritative repetitions passed
stability admission in thirty-one attempts and passed every product, trace,
reconstruction, perturbation, dominance, and blind-prediction rule. Intent-to-
exact-input acknowledgement measured 196.689/286.493ms median/p95, attachment
10.674/17.194ms, residual 16.234/23.847ms, actual-request wire/client work
9.052/11.388ms, and server-send-to-client-frame egress 7.126/10.419ms.

Server send return to client socket-data callback measured 7.097/10.329ms,
supplied 99.1% of response-egress p95, and supplied at least 98.9% of every one
of the eighteen intervals over 6ms. All post-callback frame extraction, JSON
parse, queue, waiter, iterator, dequeue, yield, and outer-continuation work
combined measured 0.034/0.081ms. The largest transport reconstruction error was
0.000219ms and cross-process order remained nonnegative. The frozen prediction
and every named phase bound passed.

All temporary behavior and diagnostics must be reverted from the review
branch. BENCH-045 proves ownership but does not distinguish inherent Bun/Unix-
socket delivery from native TUI event-loop occupancy. Next compare a standalone
compiled client, an idle native TUI connection, and the active Quick Session
path under the same admitted Observer response before proposing worker,
polling, or transport changes.

## BENCH-046-P registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`tests/README.md`, the original experiment protocol, BENCH-044-W, and
BENCH-045-D. BENCH-045 accepted only the boundary attribution: 99.1% of
response-egress p95 elapsed after the Observer's socket write returned and
before the native TUI's socket-data callback began. Source inspection confirms
OpenTUI is configured for on-demand rendering, but BENCH-045 cannot distinguish
Bun/Unix-socket dispatch latency from work occupying the TUI process.

BENCH-046 retains BENCH-045's exact temporary launch behavior, trace layers,
twenty admitted compiled-product repetitions, and full correctness matrix. It
adds one paired standalone Bun socket-delivery control per repetition. A test-
owned Unix socket server in the Vitest process returns its comparable epoch
timestamp as a newline-delimited number; a fresh Bun client connects before
measurement, sends one ping, records socket callback entry, validates the
finite timestamp, and exits with strict JSON. Client process startup,
connection, request ingress, and server work occur before the measured server-
send-to-callback interval. Each standalone control and each product repetition
has its own BENCH-044 stability admission. Pair order alternates by repetition
to counterbalance drift, and no admitted result is filtered.

Expected temporary files inherited from BENCH-045 are
`station/src/app/dashboardCapabilities.ts`,
`station/src/app/dashboardCapabilities.test.ts`,
`station/src/input/runtime/managedLaunch.ts`,
`station/src/input/runtime/managedLaunch.test.ts`,
`station/src/input/runtime/managedLaunchAttempt.ts`,
`station/src/input/runtime/managedLaunchPhaseDiagnostic.ts`,
`apps/observer/src/runtime/externalLaunch.ts`,
`apps/observer/src/runtime/externalLaunchPhaseDiagnostic.ts`,
`packages/protocol/src/client.ts`, `packages/protocol/src/server.ts`,
`packages/protocol/src/transport.ts`,
`packages/protocol/src/prepareExternalLaunchPhaseDiagnostic.ts`, and
`tests/performance/quick-session/compiledQuickSessionTui.real.test.ts`.
BENCH-046 changes only the runner beyond archived BENCH-045 source and writes
its standalone client beneath the per-run temporary root. Raw JSON, a
standalone archive summary, and this ledger are the evidence artifacts. No
package manifest, shared contract/schema, provider, connector, configuration,
architecture, permanent test, report, or user-documentation change is expected.

JSDoc impact is explicit: no new or changed JSDoc is expected beyond inherited
temporary BENCH-045 diagnostic contracts. No retained backend, connector, or
protocol JSDoc change is expected because all instrumentation will be reverted
after classification.

The table row freezes the decision before diagnostic source is restored. All
twenty standalone controls and product repetitions must pass independent
admission, strict parsing, process exit, and every BENCH-045 product predicate.
The standalone server and temporary roots must close cleanly. User-facing p95
remains at most 380ms, attachment p95 at most 30ms, residual p95 at most 35ms,
and active response-egress p95 at most 15ms. At least fifteen pairs must show
active-TUI pre-callback latency at least 4ms slower than standalone, and the
standalone p95 must be at least 60% below active-TUI p95. Prediction: standalone
Bun server-send-to-callback latency is at most 1ms median and 2ms p95, is at
least 70% below active-TUI p95, and standalone callback-to-validated-exit work
is at most 0.2ms p95. This predicts TUI-process occupancy rather than inherent
Bun/Unix-socket delivery; any failed condition rejects that attribution.

Validation before the paired run will repeat Protocol, Observer, and Station
typechecks; Protocol transport unit and client/server integration tests,
Observer external-launch unit, focused temporary dashboard/managed-launch
tests, Biome, `git diff --check`, the runner's skipped-mode compile, and a
single strict standalone-probe smoke. No production optimization is registered
until BENCH-046 passes every paired, stability, and product guard; an accepted
result still requires an idle-native-TUI comparison before proposing a change.

Outcome: rejected attribution. All twenty product repetitions and all forty
independent stability admissions passed in fifty-one attempts. Product intent-
to-exact-input acknowledgement was 189.949/225.946ms median/p95, attachment was
10.001/21.126ms, residual was 15.223/27.924ms, response egress was
5.893/11.995ms, and active server-send-to-TUI-callback delay was
5.858/11.959ms. Every product, trace, perturbation, cleanup, and server-request
predicate passed.

Nineteen controls had nonnegative Node/Bun comparable-clock order and measured
2.746/3.329ms server-send-to-callback plus 0.009/0.033ms callback-to-validation.
One admitted, otherwise clean control measured -0.104ms across that epoch
boundary, failing the frozen all-control rule. Across nineteen valid pairs, the
active-minus-standalone delay was 3.412/15.778ms; only eight pairs were at least
4ms slower in the active TUI versus the required fifteen. Standalone valid-pair
p95 was 79.4% below active p95, but its median and p95 missed the predicted 1ms
and 2ms absolute bounds. The blind prediction and mechanical attribution both
failed, so no production optimization is authorized.

All temporary behavior and diagnostics remain archive-only. The result rules
out the registered sub-2ms universal standalone baseline but still shows an
inconsistent active-TUI increment and heavier tail. Next compare an idle native
TUI connection and the active Quick Session path inside the same Bun process
against the same Observer response, eliminating the cross-runtime epoch
ambiguity before proposing a worker, polling, or transport change.

## BENCH-047-I registered diagnostic plan

Governing sources are `docs/debugging.md`, `docs/architecture.md`,
`docs/observer-architecture.md`, `docs/architecture-documentation.md`,
`docs/configuration.md`, `tests/README.md`, the original experiment protocol,
BENCH-045-D, and BENCH-046-P. BENCH-046 rejected its TUI-occupancy attribution:
only eight of nineteen valid active/standalone pairs differed by at least 4ms,
the standalone control missed its 1/2ms median/p95 prediction, and one Node/Bun
epoch comparison was negative. The active native path nevertheless retained a
heavier 5.858/11.959ms server-send-to-callback distribution versus the valid
standalone control's 2.746/3.329ms, so the remaining question is whether native
TUI activity owns a repeatable increment when both observations use the same
TUI and Observer processes.

BENCH-047 retains BENCH-045's exact temporary launch behavior and trace layers,
twenty compiled-product repetitions, and full correctness matrix. After the
dashboard is rendered and the runner's startup checks settle, the runner sends
one `SIGUSR2` to the exact native TUI PID. A temporary one-shot handler issues a
fresh `observer.health` request through the same Bun protocol/transport code,
then writes a strict completion sentinel containing no timing data. Only after
that idle probe completes does the runner admit and start Quick Session. The
active comparison remains the `agent.prepareExternalLaunch` response. Idle and
active server-send-return-to-socket-callback timestamps therefore share one TUI
process, one Observer process, one Bun runtime implementation on both sides,
and one comparable-clock offset. They intentionally use different validated
response methods; BENCH-045 already bounds all active post-callback parsing at
0.081ms p95, and BENCH-047 separately reconstructs both delivery intervals.

Idle always precedes active so the control cannot inherit a created worktree,
session, pane, or terminal. Each idle probe and active Quick attempt receives a
separate BENCH-044 stability admission immediately before its measured request;
all attempts are retained, and no admitted sample is filtered. The signal
handler is one-shot, removed during Station shutdown, and enabled only by a
strictly parsed temporary completion-path environment value. The sentinel is a
coordination witness, not timing evidence; protocol traces remain memory-only
and exit-only. No renderer state, response, request, retry, timeout, validation,
focus, or launch behavior changes.

Expected temporary files inherited from BENCH-046 are
`station/src/app/dashboardCapabilities.ts`,
`station/src/app/dashboardCapabilities.test.ts`,
`station/src/input/runtime/managedLaunch.ts`,
`station/src/input/runtime/managedLaunch.test.ts`,
`station/src/input/runtime/managedLaunchAttempt.ts`,
`station/src/input/runtime/managedLaunchPhaseDiagnostic.ts`,
`apps/observer/src/runtime/externalLaunch.ts`,
`apps/observer/src/runtime/externalLaunchPhaseDiagnostic.ts`,
`packages/protocol/src/client.ts`, `packages/protocol/src/server.ts`,
`packages/protocol/src/transport.ts`,
`packages/protocol/src/prepareExternalLaunchPhaseDiagnostic.ts`, and
`tests/performance/quick-session/compiledQuickSessionTui.real.test.ts`.
BENCH-047 additionally changes
`station/src/sources/observerStationClient.ts` and adds temporary
`station/src/sources/observerTransportDeliveryProbe.ts` plus
`station/src/sources/observerTransportDeliveryProbe.test.ts`. Raw JSON, a
standalone archive summary, and this ledger are the evidence artifacts. No
package manifest, shared contract/schema, provider, connector, runtime config,
architecture, permanent benchmark, report, or user-documentation change is
expected.

JSDoc impact is explicit: the temporary protocol client option will document
that it arms only the single idle health response, and the transport diagnostic
method will document its idle/active scope without granting delivery authority.
No controlled Observer seam changes. The Station signal helper is temporary
diagnostic composition rather than a retained application port, adapter, use
case, policy, or composition root; it requires only a concise one-shot signal
and completion invariant comment. No retained JSDoc change is expected because
all instrumentation will be reverted after classification.

All twenty idle and active measurements must pass their forty independent
admissions, strict parsing, exact one-shot sentinel, process exit, and every
BENCH-045 product predicate. Both trace scopes must occur exactly once, be
monotonic and nonnegative across processes, remain absent before their owning
process exits, and reconstruct their server-send-to-client-frame intervals
within 1ms. User-facing p95 remains at most 380ms, attachment p95 at most 30ms,
residual p95 at most 35ms, and active response-egress p95 at most 15ms. Attribute
native TUI activity only if at least fifteen of twenty pairs show active
pre-callback latency at least 2ms above idle and idle p95 is at least 40% below
active p95. Prediction: idle native pre-callback latency is at most 3ms median
and 5ms p95, at least fifteen pairs differ by 2ms, idle p95 is at least 50%
below active p95, and idle callback-through-validation p95 is at most 0.2ms.
Any failed condition rejects the attribution mechanically.

Validation before the authoritative run will repeat Protocol, Observer, and
Station typechecks; Protocol transport unit and client/server integration tests,
Observer external-launch unit, focused dashboard/managed-launch tests, the new
signal-probe unit test, Biome, `git diff --check`, the runner's skipped-mode
compile, and one structural native idle-probe smoke whose timing is not inspected
or admitted into the result. No production optimization is registered until
BENCH-047 passes every trace, paired, stability, and product guard. An accepted
result would still require attribution of the exact synchronous TUI work before
proposing a worker or scheduler change; a rejection redirects the next
experiment to inherent Bun/Unix-socket dispatch and Observer send timing.

## BENCH-047-P measured native TUI idle-control outcome

BENCH-047 ran from frozen diagnostic commit `5b7da6487`. Its structural smoke
first proved a runner-boundary mistake without admitting timing: tmux's pane PID
was the CLI launcher rather than its native `stn __tui` renderer child, so the
signal terminated the launcher and no completion sentinel appeared. The runner
was corrected before the authoritative run to require exactly one direct
renderer child with the compiled executable's exact `__tui` command. The
repeated structural smoke then passed one complete run, two admissions, exact
sentinel identity, 23/25 client idle/active events, 5/9 server idle/active
events, exit-only persistence, and every correctness predicate. Its timing was
not inspected or admitted into the result.

The authoritative 20-pair run completed in 196 seconds. All twenty product runs
were safe, all forty independent idle/active admissions passed in 46 attempts,
no safety predicate was false, both trace scopes occurred exactly once per run,
every cross-process order was nonnegative, and the maximum response-interval
reconstruction error was 0.000223ms. Admitted immediate-turn p95 observations
had 0.157ms p95 and admitted process-launch p95 observations had 4.462ms p95.
The one-minute load average ranged from 13.39 to 29.07 on ten logical CPUs; the
registered admission checks nevertheless passed, so no sample was filtered.

The same-runtime contrast strongly matched the narrow occupancy direction. The
active server-send-to-renderer-callback distribution was 6.605/20.172ms
median/p95, while idle native delivery was 0.042/0.486ms. All twenty active
samples exceeded their paired idle sample by at least 2ms; paired differences
were 6.566/20.115ms median/p95, and idle p95 was 97.59% below active p95. Idle
therefore passed its 3/5ms median/p95 prediction, the 15-of-20 paired guard, and
both the 40% guard and 50% predicted p95 improvement.

The experiment still rejects the registered attribution mechanically.
Idle callback-through-validation was 0.326/0.628ms rather than at most 0.2ms
p95. Product tails also exceeded every frozen bound: intent-to-interactive p95
was 575.802ms versus 380ms, attachment p95 was 44.178ms versus 30ms, transport
residual p95 was 35.227ms versus 35ms, and active response-egress p95 was
20.242ms versus 15ms. The report therefore records `failure: null`,
`allSafe: true`, `predictionPassed: false`, and `thresholdsPassed: false`.

No production optimization is retained. The result makes inherent Bun/Unix
socket delivery unlikely to own the active increment: an idle response reaches
the same renderer callback almost immediately. It does not identify which
active-only renderer activity owns the delay. The next registered diagnostic
must locate exact main-thread work between Observer response send and the active
socket callback—candidate sources are Observer event handling, client-state
reduction, terminal/Host callbacks, and native rendering—before any worker or
scheduler change is proposed. This remains an internal stage in an already-open
native overlay, not Station overlay startup.

The archived report is
`tests/performance/quick-session/bench-047-native-tui-idle-control.md`. The raw
report is
`.dev-state/performance/quick-session/bench-047-native-tui-idle-control.real.json`
(912,424 bytes; SHA-256
`86194b7ee7b94c73e606438d46970ebed022fe579edf1971d2316d6e22b6039a`).
Validation passed Protocol, Observer, and Station typechecks; 15 Protocol
transport unit tests; 43 Protocol integration tests; 65 Observer external-launch
tests; 61 focused Station dashboard, managed-launch, Observer-client, and probe
tests; Biome; `git diff --check`; the skipped-mode runner compile; and the
corrected structural native smoke.
