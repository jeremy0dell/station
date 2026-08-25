# BENCH-046-P standalone transport control

## Decision

Rejected attribution. The active native TUI path was slower than the standalone
Bun control at p95, but the result failed the frozen all-control, paired-
consistency, and blind absolute-latency rules. BENCH-046 changes no production
behavior and does not authorize a worker, polling, or transport change.

## Boundary

BENCH-046 retained BENCH-045's temporary Quick-only foreground launch, immediate
exact input, four exit-only trace layers, twenty compiled-product repetitions,
and full lifecycle matrix. It paired each repetition with one fresh Bun client
against a test-owned Node Unix-socket server. Pair order alternated before and
after the product run. Every product run and control received an independent
BENCH-044 stability admission; no admitted measurement was filtered.

The active interval begins when the Observer's response send returns and ends
when the native TUI's socket-data callback starts. The standalone interval begins
immediately before the test server writes its timestamp and ends when the fresh
Bun client's socket-data callback starts. This makes the standalone comparison
conservative by including the server write, but its Node-to-Bun comparable epoch
also produced one negative-order sample and therefore failed the registered
all-control requirement.

## Authoritative result

All forty stability admissions passed in fifty-one attempts. Admitted event-loop
p95 was 0.078/0.398ms median/p95 and admitted process-launch p95 was
2.923/4.668ms. One-minute load ranged from 12.10 to 24.58 on ten logical CPUs.

| Product distribution | Median | p95 | Max |
| --- | ---: | ---: | ---: |
| User intent to exact input acknowledgement | 189.949ms | 225.946ms | 399.190ms |
| Client-visible `prepareExternalLaunch` | 29.130ms | 47.498ms | 68.258ms |
| Observer-internal preparation | 13.590ms | 19.574ms | 27.403ms |
| Client-minus-Observer residual | 15.223ms | 27.924ms | 40.854ms |
| Host attachment resolution | 10.001ms | 21.126ms | 27.342ms |
| Actual-request wire/client remainder | 6.889ms | 13.686ms | 18.944ms |
| Server-send-to-client-frame response egress | 5.893ms | 11.995ms | 16.227ms |
| Active server-send-to-TUI-callback | 5.858ms | 11.959ms | 16.154ms |

Nineteen of twenty standalone controls had nonnegative comparable-clock order.
Their standalone server-send-to-callback distribution was 2.746/3.329ms
median/p95, and callback-to-validation was 0.009/0.033ms. One otherwise clean,
admitted control measured -0.104ms across the Node/Bun epoch boundary, so only
nineteen exact pairs were valid.

Across those nineteen pairs, active-minus-standalone delay was 3.412/15.778ms
median/p95. Only eight pairs were at least 4ms slower in the active TUI; the
frozen rule required fifteen. The valid-pair standalone p95 was 79.4% below the
valid-pair active p95, passing the 60% attribution and 70% prediction fractions,
but standalone missed the predicted 1ms median and 2ms p95 limits. The absolute
prediction and the mechanical attribution therefore failed.

## Correctness

All twenty product runs preserved exact command/trace, Project, branch/path and
registration, scripted harness, provider-neutral terminal, session/PTY, ready
marker, exact-once input, canonical UI, Host/Git inventory, process stop, stderr,
and temporary-root cleanup evidence. The standalone server closed after exactly
twenty requests, and all forty admissions passed. Product p95 guards for user
latency, attachment, residual, and response egress passed. Every inherited trace
was exact, exit-only, and reconstruction-coherent; maximum transport
reconstruction error was 0.000175ms.

Before measurement, Protocol, Observer, and Station typechecks; 15 transport
tests; 43 client/server integration tests; 65 Observer tests; 51 focused native-
launch tests; Biome; diff checks; the disabled runner compile; and the strict
standalone smoke passed.

## Next question

The control rules out a sub-2ms universal standalone baseline on this boundary,
while the active TUI still shows an inconsistent additional delay and heavier
tail. Compare an idle native TUI connection with the active Quick Session path
inside the same Bun runtime and against the same Observer server response. That
removes the Node/Bun epoch ambiguity and tests TUI activity directly before any
production optimization is proposed.
