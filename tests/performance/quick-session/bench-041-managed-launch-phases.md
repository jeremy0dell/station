# BENCH-041-P: managed-launch phase attribution

Status: **accepted for attribution** on 2026-08-25. The blind prediction was
partly disproved, and no temporary production behavior is retained.

## Question

BENCH-040-I showed that immediate input is safe once the native pane is
foregrounded, but its p95 tail accumulated before focus. BENCH-041-P rebuilt
the same foreground/automatic-dismissal candidate and placed in-memory marks
around each successful managed-launch phase. The UI emitted its structured
trace only at process exit, after interaction and cleanup, so trace I/O did not
enter the measured boundary.

The compiled build identity was:

`0.0.0-pre-alpha.5.16+station.241a000e2fdac5da737f15f4fa1c818dc645dce040537121e32fafadde7c9726`

## Result

All twenty product repetitions passed every named correctness predicate and
carried one exact, monotonic, phase-sum-coherent exit trace. Command completion
to automatic overlay-close request measured 52.125/81.176ms median/p95.

| Internal phase | Median | p95 |
| --- | ---: | ---: |
| Observer `prepareExternalLaunch` | 31.282ms | 59.990ms |
| Host attachment resolution | 13.188ms | 24.982ms |
| Pane publication to attempt completion | 5.291ms | 9.637ms |
| Resolved attachment to terminal placement | 0.447ms | 0.663ms |
| Managed preflight | 0.185ms | 0.473ms |
| Every other individual segment | at most 0.134ms | at most 0.506ms |

`prepareExternalLaunch` supplied 73.9% of total p95 and at least half of three
of the four intervals over 75ms. This passed the preregistered requirement of a
60% p95 share and two dominated tail intervals. The fourth tail attributed
48.4% to preparation because attachment resolution expanded to 29.5ms.

User-facing intent to exact input acknowledgement measured 235.400/344.703ms
median/p95, under the registered 380ms p95 diagnostic guard. Focus to
acknowledgement was 22.875/56.376ms.

## Prediction and decision

The predicted 70% preparation p95 share passed, but the full prediction failed:
preparation did not supply half of every tail, and attachment resolution p95 was
24.982ms rather than at most 10ms. The diagnostic is nevertheless accepted
because its separate attribution rules passed exactly.

The result authorizes only the conclusion that Observer launch preparation is
the dominant pre-focus phase and Host attachment resolution is the second
material phase. The temporary foreground/automatic-dismissal behavior,
in-memory recorder, source-adjacent tests, and JSDoc must all be reverted. The
next diagnostic should split Observer preparation into mutation admission,
managed-target inventory, persistence, workspace opening, harness-plan
construction, Host process launch, and narrow canonical projection.

## Safety

Every run preserved exact command/trace, project, worktree branch/path and Git
registration, scripted harness, provider-neutral native terminal, immutable
session/PTTY, ready and exact-once immediate-input acknowledgement, canonical
UI, empty Host cleanup, 49-worktree Git restoration, clean UI/Observer stops,
accepted progress stderr, and temporary-root removal. Before UI exit, stderr
contained only the expected progress lines; the diagnostic trace appeared only
during exit.
