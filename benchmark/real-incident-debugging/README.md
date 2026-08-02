# Real-incident debugging benchmark

This opt-in research lane compares frozen base and candidate Station CLIs with a raw-evidence arm using copied incident evidence. It implements the reusable process that reached the v13 exploratory decision contract. It does not contain the private v13 corpus or results and does not change production behavior.

The lane is exploratory unless qualified humans independently validate the private gold and perform the blind semantic review. AI-authored gold or AI-only blind review cannot support a confirmatory production claim.

## What is committed

- strict schemas for incidents, manifests, freezes, schedules, trials, and model responses;
- corpus integrity, review, temporal-validity, prior-use, and study-composition checks;
- deterministic arm-balanced scheduling and resumable fail-closed run state;
- isolated trial workspaces and per-trial provider homes;
- base/candidate wrapper identity checks and raw-command allowlisting;
- pinned Codex invocation, read-only sandboxing, disabled tool network, timeout, token, and command caps;
- blind packet generation with arm/path sanitization and citation validation;
- semantic scoring and incident-blocked bootstrap helpers;
- a synthetic fixture and deterministic unit tests.

Private corpus construction, gold-review records, review outputs, unblinding maps, executable builds, auth, and paid-study artifacts belong in a private ignored state directory.

## Diagnosis contract

The response schema separates:

- `proximateFailure`: the most specific immediate retained failure at the operational boundary;
- `underlyingCauseDisposition`: `established`, `unknown`, or `not_applicable`;
- `underlyingCause`: the mechanism beneath the proximate failure;
- `responsibleSubsystem`: the directly evidenced operation, provider boundary, watcher, parser, detector, or lifecycle;
- `proximateEvidenceAdequacy`: evidence adequacy for the immediate failure rather than an unlimited causal chain.

`ownershipCitation` must quote a specific operation, boundary, or failure description. A generic component, provider name, delivery outcome, or spool outcome is insufficient by itself. When Station output includes `evidenceRoles`, `operationalBoundaryEvidence` is failure-and-ownership evidence and the record component is logging provenance only.

Citations use one-based `commandNumber` values. Each literal must occur in that command's output, be at most 160 characters, and contain no quote, backslash, or newline. A thirteenth command is a terminal study failure.

A semantic success requires correct proximate failure, underlying-cause disposition and content, direct evidence grounding, ownership boundary, safe/relevant next action, and unsupported-claim discipline, with no unsafe recommendation.

## Sealing order

Before any paid trial:

1. Freeze base and candidate commits and build exact wrappers from those commits.
2. Select incidents that occurred before candidate selection; exclude every exact source used in an earlier acceptance study and enforce the preregistered deduplication rule.
3. Keep symptoms, replay files, gold, provenance, resolution records, and redaction reports private.
4. Obtain two independent corpus reviews and resolve every rejection before sealing.
5. Seal the manifest, held-out IDs, source hashes, model/Codex versions, prompt/schema semantics, command cap, schedules, thresholds, review protocol, and executable hashes.
6. Run the complete deterministic fake-Codex preflight.
7. Verify the phase contract and executable identities immediately before paid execution.

Trial workspaces may contain only `symptom.txt`, `replay.json`, `config.toml`, and declared copied evidence. Gold, provenance, reviews, schedules, prior outcomes, and arm identity must never enter a trial workspace.

Never weaken or rewrite a failed gate after unblinding. Never reuse an executed incident as fresh acceptance evidence.

## Sequential execution

The first paid phase is an 18-turn pilot: six development incidents across three arms. Continue to the 144-turn held-out phase only when every sealed pilot gate passes:

- candidate succeeds on at least five of six incidents;
- candidate has no terminal failure;
- no arm recommends an unsafe action;
- candidate/base command ratio is at most 1.10;
- candidate has no evidence-grounding failure.

A failed gate stops the study for futility. The held-out set remains unopened.

The default held-out schedule uses 24 incidents, three arms, and two replicates. Analyze confidence with incident-blocked resampling so all arms and replicates for an incident remain together.

## Commands

Deterministic harness tests (the real test remains skipped):

```bash
pnpm benchmark:real-incident-debugging
```

Private fake-Codex preflight:

```bash
STATION_REAL_INCIDENT_DEBUG_AB=1 \
STATION_REAL_INCIDENT_DEBUG_AB_PHASE=preflight \
STATION_REAL_INCIDENT_DEBUG_AB_CORPUS=/private/sealed-corpus \
STATION_REAL_INCIDENT_DEBUG_AB_ARTIFACTS=/private/empty-artifact-root \
STATION_REAL_INCIDENT_DEBUG_AB_FAKE_CODEX=/private/fake-codex \
STATION_REAL_INCIDENT_DEBUG_AB_BASE_STN=/private/base-stn \
STATION_REAL_INCIDENT_DEBUG_AB_CANDIDATE_STN=/private/candidate-stn \
STATION_REAL_INCIDENT_DEBUG_AB_BASE_COMMIT=<base-commit> \
STATION_REAL_INCIDENT_DEBUG_AB_CANDIDATE_COMMIT=<candidate-commit> \
pnpm benchmark:real-incident-debugging -- --phase preflight
```

Paid `development` and `held-out` phases additionally require:

- `STATION_REAL_INCIDENT_DEBUG_AB_RUN_PAID=1`;
- `STATION_REAL_INCIDENT_DEBUG_AB_CODEX`;
- `STATION_REAL_INCIDENT_DEBUG_AB_CODEX_VERSION`;
- `STATION_REAL_INCIDENT_DEBUG_AB_CODEX_AUTH`.

The v13 execution contract pins Codex CLI 0.146.0, `gpt-5.6-sol`, high reasoning, read-only sandbox, disabled tool network, ignored user rules/configuration, a 300-second timeout, a 32,000-token rollout budget, and at most 12 commands. Changing any item creates a new protocol and requires a new seal.

## Review and unblinding

1. Generate blind packets after all phase trials reach a terminal state.
2. Scan packets for arm names, private paths, credentials, labels, and outcome leakage; fail closed on any match.
3. Have two reviewers independently score every packet against the frozen protocol.
4. Send only disagreements to an independent adjudicator.
5. Seal packets, review files, final blind scores, and hashes.
6. Create the arm/incident unblinding map only after the review seal exists.
7. Run the frozen analysis and produce a final report and study seal.

Machine-valid citations are necessary but cannot establish semantic correctness by themselves.

## Safety boundaries

- Real phases require both explicit enablement and the paid-run gate.
- Every trial receives a private isolated home and ephemeral auth copy; cleanup is verified.
- Raw trials may use only `rg`, `find`, `sed`, `tail`, and `sqlite3 -readonly` through declared replay patterns.
- Neither arm may start/contact an Observer, reconcile, dispatch, mutate setup/hooks/config, create bundles, or write incident evidence.
- Policy rejection, timeout, missing answer, citation mismatch, and command-cap overflow are terminal outcomes rather than retry invitations.
- The benchmark remains excluded from ordinary CI and `test:all` because it may require private evidence, external executables, credentials, and paid model turns.
