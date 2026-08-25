# BENCH-045-D transport delivery attribution

## Decision

Accepted attribution. All twenty authoritative repetitions passed stability,
product, trace, reconstruction, perturbation, dominance, and blind-prediction
rules. Time before the client socket-data callback owns the measured response-
egress interval. BENCH-045 changes no production behavior and does not itself
authorize a transport implementation change.

## Boundary

BENCH-045 retained BENCH-044's temporary Quick-only foreground launch,
success-and-landing-only automatic overlay dismissal, immediate input, four
exit-only trace layers, per-repetition stability admission, and full lifecycle
matrix. It armed only the next response on the exact post-health prepare
connection, then marked socket callback entry, frame extraction, JSON parse,
queue publication, waiter resolution, iterator resumption, dequeue, generator
yield, and the outer caller continuation. Other protocol traffic and in-memory
connections were not recorded. No request, response, timeout, validation,
delivery, launch, focus, or cleanup behavior changed.

## Authoritative result

All twenty repetitions passed admission in thirty-one attempts. Admitted event-
loop p95 was 0.045/0.227ms median/p95 and admitted process-launch p95 was
2.226/3.705ms. One-minute load ranged from 10.56 to 18.81 on ten logical CPUs.

| Distribution | Median | p95 | Max |
| --- | ---: | ---: | ---: |
| User intent to exact input acknowledgement | 196.689ms | 286.493ms | 349.589ms |
| Client-visible `prepareExternalLaunch` | 29.969ms | 37.007ms | 58.550ms |
| Observer-internal preparation | 11.814ms | 19.007ms | 26.832ms |
| Client-minus-Observer residual | 16.234ms | 23.847ms | 31.718ms |
| Host attachment resolution | 10.674ms | 17.194ms | 19.022ms |
| Actual-request wire/client remainder | 9.052ms | 11.388ms | 14.901ms |
| Server-send-to-client-frame response egress | 7.126ms | 10.419ms | 13.418ms |

| Response-delivery segment | Median | p95 |
| --- | ---: | ---: |
| Server send return to client socket callback | 7.097ms | 10.329ms |
| All post-callback work combined | 0.034ms | 0.081ms |
| Frame extraction to JSON parse | 0.015ms | 0.033ms |
| Waiter completion to iterator resumption | 0.007ms | 0.025ms |
| Socket callback to frame extraction | 0.002ms | 0.005ms |
| Generator yield to outer continuation | 0.002ms | 0.004ms |

Pre-callback delivery supplied 99.1% of response-egress p95 and at least 98.9%
of every one of the eighteen intervals over 6ms. It was dominant in all
eighteen tails. Queue publication, waiter resolution, dequeue, and yield each
had p95 at or below 0.003ms. This satisfied the frozen prediction and rules.

## Correctness

Every run preserved exact command/trace, Project, branch/path and registration,
scripted harness, provider-neutral terminal, session/PTTY, ready marker,
exact-once immediate input, canonical UI, Host/Git inventory, process stop,
stderr, and temporary-root cleanup evidence. Every UI, client, transport,
server, and Observer trace was exact and exit-only. Cross-process order was
nonnegative; the largest transport reconstruction error was 0.000219ms.
Protocol, Observer, and Station typechecks; 15 transport tests; 43 client/server
integration tests; 65 Observer tests; 25 focused native-launch tests; Biome;
diff checks; and the disabled runner compile passed before measurement.

## Next question

Is the 7-10ms pre-callback delay inherent to Bun/Unix-socket delivery on this
machine, or is the native TUI event loop occupied when the response becomes
readable? Compare a standalone compiled client, an idle native TUI connection,
and the active Quick Session path under the same admitted Observer response
before proposing worker, polling, or transport changes.
