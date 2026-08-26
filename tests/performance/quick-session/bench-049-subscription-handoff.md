# BENCH-049 subscription handoff attribution

Date: 2026-08-25

Decision: **reject the registered hypothesis mechanically; retain no production change.**

This experiment concerns response delivery inside an already-open native Station TUI. It does not
measure opening the native overlay or launching Station. The exact subscription handoffs explained
a material part of the active response interval and passed every registered attribution floor. The
stricter blind prediction still failed on combined p95 coverage, per-run coverage, and OpenTUI frame
position, so the result does not authorize a subscription or validation optimization.

## Method

- Ran 20 complete compiled native Quick Session repetitions against a 49-worktree fixture.
- Retained BENCH-048's idle-before-active same-process control, separate admission before both
  requests, one-minute load ceiling, ordinary Observer restart, and warm preserved Station Host.
- Associated each parsed subscription frame and its separately validated Station event through
  temporary `WeakMap` identities without modifying NDJSON, protocol, event, service, or state data.
- Recorded exact frame parse/queue/wake/callback, transport iterator, protocol parse/validation,
  subscription completion, service/runtime resumption, and runtime-entry phases.
- Recorded OpenTUI's existing synchronous frame-completion event without requesting or delaying a
  render.
- Clipped the two target handoffs to active server-send-to-response-callback, unioned overlaps, then
  unioned those intervals with BENCH-048's outer renderer occupancy. No overlap was counted twice.
- Wrote the strict trace only when its native renderer exited. No event, request, response, render,
  terminal callback, focus action, state transition, or cleanup behavior was deferred or changed.

## Registered result

| Measure | Observed | Registered condition | Result |
| --- | ---: | --- | --- |
| Exact `worktree.updated` plus `session.created` handoff runs | 20/20 | 20/20 prediction; at least 15 attribution | Pass |
| Handoff-union p95 / active pre-callback p95 | 75.15% | at least 25% prediction; at least 20% attribution | Pass |
| Renderer-plus-handoff p95 / active pre-callback p95 | 81.62% | at least 85% prediction; at least 80% attribution | Prediction fail; attribution pass |
| Runs with at least 75% individual combined coverage | 17/20 | at least 15/20 attribution | Pass |
| Runs with at least 80% individual combined coverage | 15/20 | at least 18/20 prediction | Fail |
| Runs with a frame completion after worktree React and before session runtime entry | 3/20 | at least 15/20 prediction | Fail |

Every attribution condition passed, but the preregistration made any failed blind-prediction
condition reject the hypothesis. The result is therefore a measured attribution, not authority to
change production behavior.

## Timing

| Measure | Median | p95 |
| --- | ---: | ---: |
| Active server send to TUI socket callback | 6.244 ms | 9.901 ms |
| Unioned outer renderer occupancy | 2.864 ms | 5.765 ms |
| Exact target handoff union | 2.127 ms | 7.440 ms |
| Renderer-plus-handoff union | 5.372 ms | 8.081 ms |
| Per-run combined coverage | 87.54% | 92.64% |
| Remaining unoccupied active interval | 0.599 ms | 2.492 ms |

The two handoffs' summed internal phases were:

| Handoff phase | Median | p95 |
| --- | ---: | ---: |
| Socket callback complete to transport iterator dequeue | 0.041 ms | 5.342 ms |
| Transport iterator dequeue to protocol read resume | 0.006 ms | 0.009 ms |
| Protocol read resume through strict event validation | 2.501 ms | 2.956 ms |
| Event validation to subscription `next()` completion | 0.009 ms | 0.020 ms |
| Subscription completion to runtime iterator resume | 0.005 ms | 0.007 ms |
| Runtime iterator resume to event application entry | 0.001 ms | 0.003 ms |

Strict parsing and validation are the stable handoff cost. The handoff tail instead comes from four
large callback-to-iterator scheduling samples; most samples were about 0.04ms while the p95 was
5.342ms. This mixed result is another reason not to infer that schema validation alone owns the
active tail.

## Product guards

| Measure | Median | p95 | Registered p95 bound | Result |
| --- | ---: | ---: | ---: | --- |
| Intent to interactive input acknowledgment | 207.055 ms | 312.230 ms | 380 ms | Pass |
| Attachment resolution | 13.454 ms | 19.024 ms | 30 ms | Pass |
| Protocol transport residual | 16.712 ms | 20.801 ms | 35 ms | Pass |
| Active response egress | 6.298 ms | 9.942 ms | 15 ms | Pass |

The paired idle control remained distinct. Active server-send-to-callback was 6.244/9.901ms
median/p95 versus 0.030/0.835ms idle. All 20 active samples exceeded idle by at least 2ms, and idle
p95 was 91.56% below active p95.

## Correctness and stability

- 20/20 product runs completed safely; `failure` was null, `allSafe` was true, and no safety
  predicate was false.
- All 20 traces contained exactly one complete 11-phase `worktree.updated` handoff and one complete
  11-phase `session.created` handoff. All activity identities, timestamps, phase order, and armed
  window bounds were exact.
- Every worktree, session, terminal, exact input acknowledgment, cleanup, process-exit, inventory,
  renderer-child identity, cross-process order, and exit-only trace check passed.
- Both response scopes reconstructed within 0.000184ms, below the 1ms bound.
- 40/40 independent stability admissions passed in 44 attempts. Admitted immediate-turn p95 values
  had 0.058ms p95; admitted process-launch p95 values had 4.121ms p95.
- Admitted one-minute load was 13.83–19.87 on 10 logical CPUs, below the registered ceiling of 20.
- The mechanical outcome was `predictionPassed: false` and `thresholdsPassed: false` solely because
  the three stricter prediction conditions above failed.

## Interpretation

BENCH-049 confirms that asynchronous subscription handoff is material. Its attribution floors all
passed, and strict parsing/validation consumed a stable 2.956ms p95 across both target events. It
does not confirm the stronger prediction that renderer plus handoff explains nearly all active-tail
time. The combined wall-clock union reached 81.62% of p95 rather than 85%, only 15 runs cleared 80%
individually, and the expected OpenTUI frame position appeared only three times.

Post-result gap decomposition was descriptive and not part of the decision rule. The remaining
unoccupied interval was 0.599/2.492ms median/p95. Every run had a gap after a root React interval and
before another subscription socket callback; that recurring gap was 0.353/1.152ms. Two tail runs
waited 1.971ms and 3.538ms from active server send to the first recorded client activity, while the
gap after `session.created` application and before the active callback was 0.042/0.845ms. The first
OpenTUI frame completion predated target runtime application in every run, and only three runs
completed another frame at the predicted position. Current evidence therefore redirects the next
diagnostic to target-event publication, protocol egress, and cross-process socket scheduling rather
than native frame execution or direct subscription dispatch.

## Evidence

- Raw report: `tests/performance/quick-session/bench-049-subscription-handoff.real.json`
- SHA-256: `be343d746c6f791dedc3dc321164633be0a20007d2d46a32d2485d11ff2293cc`
- Raw size: 2,365,966 bytes
- Runner commit: `56e5d4e95`
- Mechanical outcome: `failure: null`, `allSafe: true`, `predictionPassed: false`,
  `thresholdsPassed: false`

Validation passed Protocol, Client, Dashboard Core, Observer, and Station typechecks; 15 Protocol
transport unit tests; 43 Protocol client/server integration tests; 49 Client runtime/reducer tests;
16 Client service integration tests; 49 Dashboard runtime/effect-scope tests; 65 Observer
external-launch unit tests; 8 Observer external-launch integration tests; 73 focused native Station
dashboard, managed-launch, Observer-client, probe, and profiler tests; Biome; `git diff --check`; the
skipped-mode runner load; and the timing-blind structural native smoke. The repository-wide
architecture manifest check remains intentionally inapplicable to this archive-only branch because
its inherited temporary diagnostic modules are not retained in the reviewed product branch.

## UX implication and manual verification

No product behavior changed. The measured interval is an internal stage after the native Station
overlay is already open; it is separate from overlay startup. To verify manually, open native
Station first, invoke Quick Session, and confirm that the overlay lands on the new session and
accepts one typed input exactly once. BENCH-049 verified that behavior in all 20 runs.
