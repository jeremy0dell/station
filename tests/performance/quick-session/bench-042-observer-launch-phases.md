# BENCH-042-O Observer launch-phase attribution

## Decision

Rejected mechanically. The twenty-run authoritative attempt passed every
correctness and trace-safety predicate, but it failed two preregistered
attribution conditions: no Observer-internal preparation exceeded 40ms, and the
client-visible RPC minus Observer-internal duration was 24.070ms p95 rather than
at most 15ms. The temporary foreground behavior and both diagnostic layers are
not eligible for retention.

## Boundary

This diagnostic retained BENCH-041's temporary Quick-only foreground launch,
success-and-landing-only overlay dismissal, immediate input, and exit-only UI
phase trace. It added Observer in-memory marks around mutation admission,
managed-target inventory, harness preflight, session persistence, managed
workspace opening, harness launch-plan construction, Host managed-process
launch, and narrow canonical projection. The Observer artifact was written only
at normal process exit and parsed after clean stop.

The authoritative run used twenty fresh compiled native product repetitions on
an Apple M4 with Bun 1.3.14, Worktrunk 0.72.0, and tmux 3.7b. Binary build time
was excluded from every timing sample.

## Authoritative result

| Distribution | Median | p95 | Max |
| --- | ---: | ---: | ---: |
| User intent to exact input acknowledgement | 224.422ms | 345.434ms | 401.724ms |
| Focus to exact input acknowledgement | 28.536ms | 42.170ms | 186.396ms |
| Command completion to overlay close | 52.815ms | 67.236ms | 73.014ms |
| Client-visible `prepareExternalLaunch` | 33.063ms | 46.225ms | 56.996ms |
| Observer-internal preparation | 15.745ms | 23.227ms | 31.775ms |
| Client minus Observer internal | 17.856ms | 24.070ms | 25.222ms |
| Host attachment resolution | 12.182ms | 18.729ms | 25.497ms |

Host managed-process launch was the largest Observer-internal phase at
11.453/18.799ms median/p95, or 80.9% of internal p95. Other named p95s were
4.170ms for managed-target inventory, 1.737ms for harness preflight, 1.265ms for
session persistence, 1.343ms for canonical projection, and below 0.3ms for the
remaining material segments.

The Host-share portion of the prediction was directionally correct, as were the
inventory, persistence, and projection bounds. It did not establish an
actionable attribution: there were zero internal samples over the registered
40ms tail boundary, and the 24.070ms transport/dispatch residual missed both the
15ms acceptance guard and the predicted 10ms bound.

## Correctness

All twenty repetitions retained exact command/trace, Project, branch/path and
registration, scripted harness, provider-neutral native terminal, session/PTTY,
ready marker, exact-once immediate input, canonical UI, Host/Git inventory,
process-stop, accepted stderr, phase-sum, and temporary-root evidence. Both UI
and Observer marker arrays were exact and monotonic. Every artifact was absent
before its owning process exited, and all setup/cleanup predicates passed.

## Diagnostic correction history

The first attempt was invalid because the TUI process also loaded the Observer
diagnostic module and wrote an empty artifact at its own exit; the later
Observer exit then overwrote it with the valid events. The second attempt
reversed teardown and was invalid because the subsequent TUI exit overwrote the
valid Observer artifact with an empty array. Both raw reports are retained.

The authoritative attempt changed only the diagnostic witness: an exit handler
writes only when that process recorded at least one phase. Normal TUI-then-
Observer teardown, every preregistered threshold, and the measured product path
remained unchanged.

## Next question

Split the approximately 24ms p95 client/Observer residual across client request
construction and serialization, socket queue/write/read, Observer transport
dispatch before `prepareExternalLaunch` entry, and response serialization and
delivery. Do not optimize Host launch from its descriptive within-Observer
share until a registered product-boundary experiment isolates an actionable
end-to-end contribution.
