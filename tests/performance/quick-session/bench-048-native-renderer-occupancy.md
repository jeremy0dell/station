# BENCH-048 native renderer occupancy

Date: 2026-08-25

Decision: **reject the registered attribution mechanically; retain no production change.**

This experiment concerns response delivery inside an already-open native Station TUI. It does not
measure opening the native overlay or launching Station. The two projected launch events and React
updates occurred in every run, and native renderer work occupied a material part of the active
response interval. The wall-clock occupancy union did not meet either the registered prediction or
attribution floor, so the result does not authorize a batching or scheduling optimization.

## Method

- Ran 20 complete compiled native Quick Session repetitions against a 49-worktree fixture.
- Retained BENCH-047's idle-before-active control in the same native renderer and Observer
  processes, one ordinary Observer restart per repetition, and a warm preserved Station Host.
- Required separate stability admission immediately before each idle and active request, adding a
  one-minute load ceiling of twice the machine's logical CPU count.
- Armed an observation-only memory trace before active request construction and closed it at entry
  to that response's socket callback.
- Recorded other socket callbacks, client runtime event reduction/listener/hook phases, nested
  dashboard projection/notification phases, and root React Profiler intervals.
- Clipped competing-socket, client-runtime, and React intervals to server-send-to-active-callback,
  then unioned overlaps. Dashboard work remained nested and React `actualDuration` remained a
  separate aggregate rather than being added to wall-clock occupancy.
- Wrote the strict trace only when its native renderer exited. No event, state transition, render,
  request, response, terminal callback, focus action, or cleanup behavior was deferred or changed.

## Registered result

| Measure | Observed | Registered condition | Result |
| --- | ---: | --- | --- |
| Exact `worktree.updated` plus `session.created` runs | 20/20 | 20/20 prediction; at least 15 attribution | Pass |
| Runs with a root React update | 20/20 | at least 18 prediction; at least 15 attribution | Pass |
| React actual-duration p95 / active pre-callback p95 | 121.22% | at least 50% | Pass |
| Occupancy-union p95 / active pre-callback p95 | 58.55% | at least 80% prediction; at least 70% attribution | Fail |
| Runs with at least 60% individual occupancy | 5/20 | at least 15/20 | Fail |

React `actualDuration` can exceed the elapsed response interval because it aggregates component
render time across multiple commits. It was preregistered as a separate corroborating measure and
was never treated as additive wall-clock occupancy.

## Timing

| Measure | Median | p95 |
| --- | ---: | ---: |
| Active server send to TUI socket callback | 5.954 ms | 7.788 ms |
| Unioned outer renderer occupancy | 3.342 ms | 4.560 ms |
| Per-run occupancy fraction | 55.30% | 71.30% |
| Root React wall-clock interval union | 2.868 ms | 4.196 ms |
| Root React aggregate actual duration | 5.033 ms | 9.441 ms |
| Client runtime event interval union | 0.390 ms | 0.617 ms |
| Nested dashboard source interval union | 0.243 ms | 0.419 ms |
| Other socket callback interval union | 0.022 ms | 0.048 ms |
| Unoccupied active interval | 2.354 ms | 3.546 ms |

The post-result gap decomposition is descriptive and was not part of the accept/reject rule. The
largest unrecorded intervals were between subscription socket callback completion and typed client
runtime event entry: `worktree.updated` was 1.003/1.741ms median/p95 and `session.created` was
0.979/2.020ms. The gap after the worktree React interval and before the session socket callback was
0.364/0.961ms. After `session.created` application, the active response callback followed in
0.030/0.104ms. A follow-up therefore needs to distinguish subscription transport iterator
scheduling from OpenTUI post-commit work before proposing an optimization.

## Product guards

| Measure | Median | p95 | Registered p95 bound | Result |
| --- | ---: | ---: | ---: | --- |
| Intent to interactive input acknowledgment | 198.288 ms | 238.699 ms | 380 ms | Pass |
| Attachment resolution | 11.916 ms | 17.894 ms | 30 ms | Pass |
| Protocol transport residual | 13.791 ms | 20.048 ms | 35 ms | Pass |
| Active response egress | 5.983 ms | 7.831 ms | 15 ms | Pass |

The paired idle control remained distinct. Active server-send-to-callback was 5.954/7.788ms
median/p95 versus 0.030/1.046ms idle. All 20 active samples exceeded idle by at least 2ms; paired
differences were 5.926/7.280ms, and idle p95 was 86.57% below active p95.

## Correctness and stability

- 20/20 product runs completed safely; `failure` was null, `allSafe` was true, and no safety
  predicate was false.
- Every worktree, session, terminal, exact input acknowledgment, cleanup, process-exit, inventory,
  renderer-child identity, cross-process order, and exit-only trace check passed.
- All 20 occupancy traces strictly parsed with globally monotonic timestamps and matched activity
  phase sequences. Both response scopes reconstructed within 0.000209ms, below the 1ms bound.
- 40/40 independent stability admissions passed in 41 attempts. Admitted immediate-turn p95 values
  had 0.068ms p95; admitted process-launch p95 values had 3.678ms p95.
- One-minute load was 11.33–18.54 on 10 logical CPUs, below the registered ceiling of 20.
- The mechanical outcome was `predictionPassed: false` and `thresholdsPassed: false` solely because
  the occupancy-fraction and per-run explanation conditions failed.

## Interpretation

BENCH-048 confirms that the Observer's active launch path delivers exactly one `worktree.updated`
and one `session.created` application before the response callback, and that React rendering is
present every time. That renderer work is material, but the strict outer wall-clock union explains
only 58.55% of active pre-callback p95. The hypothesis that recorded native renderer work dominates
the interval is therefore rejected.

The remaining time is not at the dashboard projection boundary: its nested p95 was only 0.419ms.
It is also not after session application: the response callback usually followed within 0.104ms
p95. Current evidence points more narrowly to asynchronous subscription-frame delivery between the
socket callback and client runtime application, plus a smaller interval after React commit. Those
boundaries require another registered diagnostic; this result alone does not justify direct event
dispatch, notification batching, render suppression, or scheduler changes.

## Evidence

- Raw report: `tests/performance/quick-session/bench-048-native-renderer-occupancy.real.json`
- SHA-256: `71c18e6c747e72a35b9193845ef9e209c0fee67cdb0729d5d1c79f08a4234080`
- Raw size: 1,398,988 bytes
- Runner commit: `3973e6b49`
- Mechanical outcome: `failure: null`, `allSafe: true`, `predictionPassed: false`,
  `thresholdsPassed: false`

Validation passed Protocol, Client, Dashboard Core, Observer, and Station typechecks; 15 Protocol
transport unit tests; 43 Protocol client/server integration tests; 49 Client runtime/reducer tests;
49 Dashboard runtime/effect-scope tests; 65 Observer external-launch unit tests; 8 Observer
external-launch integration tests; 65 focused native Station dashboard, managed-launch,
Observer-client, probe, and profiler tests; Biome; `git diff --check`; the skipped-mode runner
compile; and the timing-blind structural native smoke. The repository-wide architecture manifest
check remains intentionally inapplicable to this archive-only branch because its temporary
diagnostic modules are not retained in the reviewed product branch.

## UX implication and manual verification

No product behavior changed. The measured interval is an internal stage after the native Station
overlay is already open; it is separate from overlay startup. To verify manually, open native
Station first, invoke Quick Session, and confirm that the overlay lands on the new session and
accepts one typed input exactly once. BENCH-048 verified that behavior in all 20 runs.
