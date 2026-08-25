# BENCH-040-I: immediate focused-pane input

Status: **mechanically rejected** on 2026-08-25. The narrower buffering
diagnosis passed, but the registered end-to-end latency gates did not.

## Question

EXP-016 waited for the scripted harness-ready marker before writing input after
automatic native pane focus. BENCH-040-I reused that experiment's exact rejected
candidate binary and instead wrote through the focused TUI PTY immediately when
the Station overlay disappeared. This tested whether the Host-backed child PTY
could safely buffer input before harness readiness.

The binary was not rebuilt. Its embedded build identity was:

`0.0.0-pre-alpha.5.16+station.35acc427d7a27d641d8b0295a07faf73e78270230eed4fff0d19e0ab3f9fa744`

## Result

All ten runs passed every named correctness predicate. Every input write
occurred within 0.064ms of automatic dismissal, every unique token was
acknowledged exactly once by the expected immutable session/PTTY, and candidate
runs sent no overlay-dismissal input byte. One live-observed run wrote 115ms
before harness readiness and still received its exact acknowledgement. That is
direct evidence that a focused Host-backed PTY safely accepts buffered input at
this boundary.

The registered performance decision still failed:

| Metric | Result | Gate | Decision |
| --- | ---: | ---: | --- |
| Intent to interactive median | 183.669ms | at most 200ms | Pass |
| Intent to interactive p95 | 349.019ms | at most 320ms | Fail |
| p95 improvement from EXP-016 | 2.4% | at least 10% | Fail |
| Dismissal to acknowledgement p95 | 118.032ms | at most 120ms | Pass |
| Dismissal to input-write maximum | 0.064ms | at most 10ms | Pass |
| Earliest pre-ready write | 114.635ms before ready | at least one by 25ms | Pass |

The 349ms tail spent 317ms reaching automatic foreground focus and only 32ms
from focus to acknowledgement. Command completion was at 181ms and Host
readiness at 266ms in that sample. The remaining target is therefore before
foreground focus, not an avoidable post-focus readiness wait.

## Decision and safety

BENCH-040-I remains rejected because preregistered latency gates are binding.
Its buffer-safety attribution is retained, but it cannot retroactively accept
EXP-016 or authorize that reverted production behavior. No production source,
test, documentation, contract, protocol, or configuration file changed for this
diagnostic.

The runner intentionally exits with a failed assertion because
`thresholdsPassed` is false. The raw JSON was written before that assertion and
contains the exact distributions, named safety predicates, phase timestamps,
identities, inventories, shutdown results, and resource evidence.
