# BENCH-044-W wire attribution

## Decision

Rejected mechanically. The authoritative twenty-run attempt passed every
stability, product, trace, reconstruction, and perturbation guard, but disproved
the blind prediction that client response validation owned the actual-request
wire/client remainder. No production optimization is authorized by BENCH-044.

## Boundary

BENCH-044 retained BENCH-043's temporary Quick-only foreground launch,
success-and-landing-only automatic overlay dismissal, immediate input, and four
exit-only trace layers. Before every product repetition, it admitted execution
only after fifty `setImmediate` turns had p95 at most 1ms and ten sequential
`/usr/bin/true` launches had p95 at most 5ms. Comparable process-epoch marks
split request construction/send, request ingress, server response
construction/send, response egress, and client validation. No product request,
response, timeout, validation, launch, focus, or cleanup behavior changed.

## Authoritative result

All twenty repetitions passed admission in twenty-five attempts. Admitted
event-loop p95 was 0.065/0.505ms median/p95 and admitted process-launch p95 was
2.989/4.592ms. One-minute load ranged from 10.16 to 15.90 on ten logical CPUs.

| Distribution | Median | p95 | Max |
| --- | ---: | ---: | ---: |
| User intent to exact input acknowledgement | 174.134ms | 294.324ms | 636.636ms |
| Client-visible `prepareExternalLaunch` | 25.332ms | 33.278ms | 33.294ms |
| Observer-internal preparation | 10.687ms | 15.011ms | 17.330ms |
| Client-minus-Observer residual | 13.699ms | 20.016ms | 21.960ms |
| Host attachment resolution | 8.166ms | 18.173ms | 20.575ms |
| Actual-request wire/client remainder | 6.832ms | 11.093ms | 13.118ms |

| Actual-request wire/client segment | Median | p95 |
| --- | ---: | ---: |
| Server-send-to-client-frame egress scheduling | 5.902ms | 8.708ms |
| Request ingress scheduling | 0.154ms | 1.497ms |
| Client result validation | 0.388ms | 0.539ms |
| Request construction | 0.292ms | 0.644ms |
| Request send | 0.019ms | 0.031ms |
| Client response-envelope validation | 0.013ms | 0.019ms |

Response egress supplied 78.5% of actual-request wire/client p95 and at least
half of all five intervals over 10ms, satisfying the registered descriptive
dominance rule. Client frame-to-result validation measured 0.402/0.560ms,
supplied only 5.0% of p95, and supplied 3.2-5.4% of the five tails. This
disproved the blind prediction. Expected-build health was 2.147/4.539ms;
server response construction was 0.392/0.731ms and send was 0.014/0.021ms.

## Correctness

Every run preserved exact command/trace, Project, branch/path and registration,
scripted harness, provider-neutral terminal, session/PTTY, ready marker,
exact-once immediate input, canonical UI, Host/Git inventory, process stop,
stderr, and temporary-root cleanup evidence. Client/server/Observer/UI trace
orders and adjacent sums were exact. Cross-process order was nonnegative; full
residual reconstruction error was zero and the largest cross-clock
reconstruction error was 0.000212ms.

The first twenty-run attempt is invalid and retained separately. Its server
recorder collected unrelated expected-build health checks from other Observer
connections. The corrected recorder buffers health marks per socket and commits
only the exchange immediately preceding `prepareExternalLaunch` on that same
connection; Protocol typecheck and all 43 client/server integration tests
passed before the authoritative rerun.

## Next question

Does Bun's NDJSON transport defer delivered socket data through an avoidable
event-loop turn between the socket callback and the async message iterator? A
new diagnostic must distinguish kernel/socket arrival, frame parsing, queue
publication, and iterator resumption before any transport change is proposed.
