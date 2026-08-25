# BENCH-047 native TUI idle transport control

Date: 2026-08-25

Decision: **reject the registered attribution mechanically; retain no production change.**

This experiment concerns response delivery inside an already-open native Station TUI. It does not
measure opening the native overlay or launching Station. The same-runtime idle/active contrast was
large and repeatable, but the full registered hypothesis required every prediction, product guard,
and trace guard to pass. The callback-through-validation prediction and four product tail guards
failed, so the experiment cannot attribute the increment to native TUI activity as registered.

## Method

- Ran 20 complete compiled native Quick Session repetitions against a 49-worktree fixture.
- After the dashboard and startup checks settled, sent one signal to the strictly resolved
  `stn __tui` renderer child—not the tmux pane's CLI launcher.
- The renderer issued one idle `observer.health` request, then Quick Session issued the active
  `agent.prepareExternalLaunch` request.
- Both responses used the same native renderer process, Observer process, Bun protocol transport,
  and epoch-clock implementation. Idle always preceded active.
- Required separate stability admission immediately before each idle and active request. All 40
  admitted observations were retained.
- Kept protocol traces in memory until their owning processes exited. A timing-free sentinel only
  coordinated completion.

## Results

| Measure | Median | p95 | Registered condition | Result |
| --- | ---: | ---: | --- | --- |
| Active server send to TUI socket callback | 6.605 ms | 20.172 ms | active egress p95 ≤15 ms | Fail |
| Idle server send to TUI socket callback | 0.042 ms | 0.486 ms | ≤3/5 ms median/p95 | Pass |
| Active minus idle, paired | 6.566 ms | 20.115 ms | ≥15 pairs differ by ≥2 ms | Pass, 20/20 |
| Idle p95 improvement over active | — | 97.59% | ≥40% guard; ≥50% prediction | Pass |
| Idle callback through response validation | 0.326 ms | 0.628 ms | p95 ≤0.2 ms | Fail |
| Intent to interactive input acknowledgment | 189.618 ms | 575.802 ms | p95 ≤380 ms | Fail |
| Attachment resolution | 7.270 ms | 44.178 ms | p95 ≤30 ms | Fail |
| Protocol transport residual | 17.401 ms | 35.227 ms | p95 ≤35 ms | Fail |

The maximum reconstruction error across all 40 idle and active response intervals was
0.000223 ms, comfortably below the 1 ms bound. Every cross-process order check passed.

## Correctness and stability

- 20/20 product runs completed safely; `allSafe` was true and no safety predicate was false.
- Every worktree, session, terminal, input acknowledgment, cleanup, process-exit, and inventory
  identity check passed.
- Client traces contained exactly one 23-event idle scope and one 25-event active scope per run;
  server traces contained exactly one 5-event idle scope and one 9-event active scope per run.
- Both trace files remained absent before their owning processes exited.
- 40/40 stability admissions passed in 46 attempts. Admitted immediate-turn p95 values had
  0.157 ms p95; admitted process-launch p95 values had 4.462 ms p95.
- The machine's one-minute load average ranged from 13.39 to 29.07 on 10 logical CPUs. The
  registered admissions still passed, but the retained product outliers prohibit filtering or
  upgrading the result after the fact.

## Interpretation

BENCH-046 could not cleanly distinguish the active native response from a standalone Node/Bun
control. BENCH-047 removes that clock/runtime ambiguity: an idle response reaches the same native
renderer socket callback almost immediately, while every active response incurs at least 4.245 ms
more delay. This makes inherent Bun/Unix-socket delivery an unlikely explanation for the active
increment.

The comparison still changes the request method and surrounding activity. Active Quick Session can
drive Observer events, client-state reduction, terminal/Host callbacks, and native rendering while
the response is in flight; idle health does not. Because the callback-validation and product-tail
guards failed, the registered experiment cannot distinguish those synchronous activities or claim
a production optimization. The next diagnostic should locate exact renderer-main-thread work
between Observer response send and the active socket callback, with a fresh preregistration and no
optimization before attribution.

## Evidence

- Raw report: `.dev-state/performance/quick-session/bench-047-native-tui-idle-control.real.json`
- SHA-256: `86194b7ee7b94c73e606438d46970ebed022fe579edf1971d2316d6e22b6039a`
- Raw size: 912,424 bytes
- Runner commit: `5b7da6487`
- Mechanical outcome: `failure: null`, `allSafe: true`, `predictionPassed: false`,
  `thresholdsPassed: false`

## UX implication and manual verification

No product behavior changed. The measured delay is a small internal stage after the native Station
overlay is already open; it is separate from the roughly multi-second overlay launch path. To
verify manually, open native Station first, invoke Quick Session, and confirm that the overlay lands
on the new session and accepts one typed input exactly once. BENCH-047 verified that behavior in all
20 runs.
