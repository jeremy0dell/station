# BENCH-050 target event-egress attribution

Date: 2026-08-25

Decision: **reject the registered experiment mechanically; retain no production change.**

This experiment concerns response delivery inside an already-open native Station TUI. It does not
measure opening the native overlay or launching Station. The exact target-event egress chains passed
every registered attribution and blind-prediction condition, but the run exceeded three inherited
product latency bounds. The preregistration made any failed bound reject the experiment, so the
result identifies a frontier without authorizing an egress optimization.

## Method

- Ran 20 complete compiled native Quick Session repetitions against a 49-worktree fixture.
- Retained BENCH-049's idle-before-active same-process control, separate admission before both
  requests, one-minute load ceiling, ordinary Observer restart, and warm preserved Station Host.
- Correlated the exact `worktree.updated` and `session.created` activities through private,
  diagnostic-only object identities and the events' existing worktree IDs. No payload was changed.
- Recorded event publication entry/validation/completion, protocol iterator resumption, envelope
  validation, serialization, socket write return/callback, client socket callback, and frame parse.
- Selected only activities published after the exact user intent and written before the exact
  matched client callback. Later cleanup activities were excluded.
- Clipped publication-to-client-callback intervals to active server-send-to-response-callback and
  unioned them with BENCH-049's renderer-plus-subscription baseline without double-counting overlap.
- Wrote every strict trace only on process exit. No event, request, response, socket, render,
  terminal callback, focus action, state transition, or cleanup behavior was deferred or changed.

## Registered result

| Measure | Observed | Registered condition | Result |
| --- | ---: | --- | --- |
| Exact `worktree.updated` plus `session.created` egress runs | 20/20 | 20/20 prediction; at least 15 attribution | Pass |
| Incremental egress p95 / active pre-callback p95 | 29.32% | at least 12.5% prediction; at least 10% attribution | Pass |
| Full-union p95 / active pre-callback p95 | 96.95% | at least 92.5% prediction; at least 90% attribution | Pass |
| Runs with at least 85% individual full-union coverage | 20/20 | at least 15/20 attribution | Pass |
| Runs with at least 90% individual full-union coverage | 20/20 | at least 18/20 prediction | Pass |
| Cross-process delivery p95 | 12.929 ms | at least 0.75ms prediction; at least 0.5ms attribution | Pass |
| Cross-process delivery is the largest egress phase at p95 | Yes | Required by prediction | Pass |
| Cross-process p95 / remaining-uncovered p95 | 246.09% | at least 25% attribution | Pass |

The cross-process ratio can exceed 100% because the phase distribution sums both exact target
activities while the denominator is a wall-clock union with overlaps removed. All blind prediction
conditions passed (`predictionPassed: true`). The experiment nevertheless failed mechanically
because the inherited product guards below are also mandatory (`thresholdsPassed: false`).

## Timing

| Measure | Median | p95 |
| --- | ---: | ---: |
| Active server send to TUI socket callback | 7.258 ms | 17.750 ms |
| BENCH-049 renderer-plus-handoff baseline union | 6.240 ms | 13.552 ms |
| Target event-egress union | 5.302 ms | 9.698 ms |
| Incremental union beyond the baseline | 0.607 ms | 5.205 ms |
| Full baseline-plus-egress union | 7.201 ms | 17.209 ms |
| Per-run full-union coverage | 99.30% | 99.58% |
| Remaining unoccupied active interval | 0.639 ms | 5.254 ms |

The two exact targets' summed egress phases were:

| Egress phase | Median | p95 |
| --- | ---: | ---: |
| Event publication | 1.880 ms | 5.292 ms |
| Event bus completion to protocol iterator | 2.474 ms | 6.653 ms |
| Protocol iterator to serialization | 0.058 ms | 0.159 ms |
| Serialization | 0.007 ms | 0.020 ms |
| Synchronous socket write | 0.078 ms | 0.159 ms |
| Socket-write return to exact client callback | 5.485 ms | 12.929 ms |
| Client callback to frame parsed | 0.066 ms | 0.110 ms |

Socket-write callbacks themselves completed in 0.902/2.700ms median/p95. The stable protocol and
serialization work is sub-millisecond; scheduling between the server write return and the client
socket callback is the largest measured egress phase.

## Product guards

| Measure | Median | p95 | Registered p95 bound | Result |
| --- | ---: | ---: | ---: | --- |
| Intent to interactive input acknowledgment | 244.810 ms | 920.990 ms | 380 ms | Fail |
| Attachment resolution | 11.216 ms | 27.525 ms | 30 ms | Pass |
| Protocol transport residual | 19.032 ms | 66.918 ms | 35 ms | Fail |
| Active response egress | 7.292 ms | 17.831 ms | 15 ms | Fail |

The paired idle control remained distinct: active server-send-to-callback was 7.258/17.750ms
median/p95 versus 0.071/0.704ms idle. All 20 active samples exceeded idle by at least 2ms, and idle
p95 was 96.03% below active p95.

## Correctness and stability

- 20/20 product runs completed safely; `failure` was null, `allSafe` was true, and no safety
  predicate was false. The diagnostic mode did not request the separate safety-audit flag.
- All 20 traces contained exactly one complete nine-phase `worktree.updated` activity and one
  complete nine-phase `session.created` activity for the exact worktree correlation: 360 phase
  events, 40 complete activities, and 40 exact client matches.
- Every worktree, session, terminal, exact input acknowledgment, cleanup, process-exit, inventory,
  renderer-child identity, cross-process order, and exit-only trace check passed.
- Both response scopes reconstructed within 0.000213ms, below the 1ms bound.
- 40/40 independent stability admissions passed in 311 attempts. Admitted immediate-turn p95 values
  had 0.247ms p95; admitted process-launch p95 values had 4.253ms p95.
- Admitted one-minute load was 15.10-19.77 on 10 logical CPUs, below the registered ceiling of 20.
- The mechanical outcome was `predictionPassed: true` and `thresholdsPassed: false` because the
  three product bounds above failed.

## Interpretation

BENCH-050 confirms the registered attribution: target event egress closes the remaining active
response gap, raising p95 coverage from 76.35% to 96.95%, and cross-process delivery is its largest
phase. It does not authorize a production optimization because the same cohort was not within the
inherited end-to-end, transport-residual, or active-egress bounds.

Post-result exploration was descriptive and not part of the decision rule. One repetition had a
223.906ms active callback interval and 393.896ms summed cross-process delivery across both targets;
it also had 1,393.459ms intent-to-interactive latency, 272.017ms protocol residual, and 375.524ms
managed external-launch preparation. The p95 product sample had 920.990ms intent-to-interactive,
66.918ms protocol residual, 118.989ms external-launch preparation, and a 274.736ms final
focus-to-input acknowledgment. Those coupled stalls occurred while unrelated machine work could
resume after an admission passed. The product guards therefore did their job: they prevent a
correct attribution result from being mistaken for an optimization win under a noisy cohort.

The next highest-value experiment should separate the stable target-event egress cost from
cross-process scheduling tails under a stronger whole-repetition contention control, then test a
production-quality batching or coalescing hypothesis only if clean evidence shows avoidable Station
work rather than host scheduling owns the tail.

## Evidence

- Raw report: `tests/performance/quick-session/bench-050-target-event-egress.real.json`
- SHA-256: `e63f0e40ff94cc2f3df50ebf9904302fc7111ce7685165fa3c210cd5c634fe6d`
- Raw size: 4,247,644 bytes
- Runner commit: `c8f930f7f`
- Mechanical outcome: `failure: null`, `allSafe: true`, `predictionPassed: true`,
  `thresholdsPassed: false`

Validation passed Runtime, Protocol, Client, Dashboard Core, Observer, and Station typechecks; the
full 24-package binary build; 15 Protocol transport unit tests; 43 Protocol client/server
integration tests; 49 Client runtime/reducer tests; 16 Client service integration tests; 49
Dashboard runtime/effect-scope tests; 69 Observer event-bus and external-launch unit tests; 8
Observer external-launch integration tests; 73 focused native Station dashboard, managed-launch,
Observer-client, probe, and profiler tests; Biome; `git diff --check`; the skipped-mode runner load;
and the timing-blind structural native smoke. The repository-wide architecture manifest check
remains intentionally inapplicable to this archive-only branch because its inherited temporary
diagnostic modules are not retained in the reviewed product branch.

## UX implication and manual verification

No product behavior changed. The measured interval is internal response delivery after the native
Station overlay is already open; it is separate from overlay startup. To verify manually, open
native Station first, invoke Quick Session, and confirm that the overlay lands on the new session
and accepts one typed input exactly once. BENCH-050 verified that behavior in all 20 runs.
