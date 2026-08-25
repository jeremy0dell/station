# BENCH-043-T protocol residual attribution

## Decision

Rejected mechanically. All twenty authoritative product runs and four trace
layers were safe and exactly reconstructable, but residual p95 was 76.251ms
against a 35ms guard and user p95 was 853.612ms against a 380ms guard. The
descriptive dominant phase cannot authorize production work.

## Boundary

BENCH-043 retained BENCH-042's temporary Quick-only foreground launch,
success-and-landing-only automatic overlay dismissal, immediate input, UI
phase trace, Observer internal trace, and full product lifecycle. It added
exit-only protocol marks around runtime-boundary admission, socket connection,
expected-build health validation, actual request/response, Observer request
dispatch, and response send. No health validation, schema, timeout, connection,
request, response, or launch behavior changed.

## Authoritative result

| Distribution | Median | p95 | Max |
| --- | ---: | ---: | ---: |
| User intent to exact input acknowledgement | 222.205ms | 853.612ms | 2279.701ms |
| Client-visible `prepareExternalLaunch` | 31.187ms | 130.252ms | 234.365ms |
| Observer-internal preparation | 14.239ms | 37.500ms | 158.114ms |
| Client-minus-Observer residual | 17.601ms | 76.251ms | 92.752ms |
| Host attachment resolution | 11.009ms | 18.785ms | 22.643ms |

Every residual reconstruction error was exactly zero. Nine samples exceeded
the registered 20ms residual-tail boundary.

| Residual segment | Median | p95 |
| --- | ---: | ---: |
| Actual-request wire/client work | 9.105ms | 48.862ms |
| Expected-build health validation | 4.180ms | 24.603ms |
| Observer post-use-case response | 2.441ms | 5.840ms |
| Socket connection | 0.504ms | 2.113ms |
| Observer pre-use-case dispatch | 0.846ms | 1.221ms |
| Combined outer client settlement | 0.386ms | 0.992ms |

Actual-request wire/client work supplied 64.1% of residual p95 and at least half
of three tails, satisfying the named-phase dominance rule. Expected-build
health supplied 32.3% and less than half of every tail, disproving the blind
prediction. This remains descriptive because total residual and user latency
failed their perturbation guards.

## Correctness and environment

All twenty runs retained exact command/trace, Project, branch/path and
registration, scripted harness, provider-neutral native terminal, session/PTTY,
ready marker, exact-once immediate input, canonical UI, Host/Git inventory,
process-stop, stderr, phase, and root evidence. Every UI, client, server, and
Observer trace was exact, monotonic, sum-coherent, nonempty-owner written, and
absent until its owning process exited.

One earlier attempt ended after three safe runs on a later blank startup frame.
Seven orphaned `st-qtu-*` TUI processes from this worktree were identified and
terminated before the authoritative attempt. No other worktree or named tmux
session was changed. The valid run's one-minute load ranged from 16.0 to 23.4
on ten logical CPUs, so the fixed perturbation guards correctly prevented a
noisy tail attribution from becoming a production recommendation.

## Next question

Under a preregistered load-admission gate, add comparable-clock markers for
request send to server receive and server send to client receive. Advance only
if actual-request wire/client dominance reproduces while both user and residual
guards pass; otherwise retain the current protocol behavior.
