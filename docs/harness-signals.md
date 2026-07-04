# Harness Signals

How harness activity becomes Station status. This is the contract that harness
integrations implement and that core/TUI code may rely on. For the workflow of
adding or upgrading a harness, read `docs/harness-authoring.md`. For capturing
what a harness actually emits, read the Harness Event Census section of
`docs/debugging.md`.

## The Three Layers

1. **Transport** — how bytes reach Station: hook subprocesses (`stn-ingress`),
   app-server/JSON-RPC streams, native session files, process polling.
   Per-harness, allowed to be messy, changes with harness releases.
2. **Normalization** — harness vocabulary → the typed contract below. Pure
   functions owned by each `integrations/harness/*` package, parsed with
   provider-local strict schemas. Must run in exactly one place and one code
   version per event.
3. **Interpretation** — typed events → row/session status, attention, and UI.
   Owned by observer core and the TUI. Harness-agnostic: it may read only
   contract fields, never provider vocabulary.

Bugs live at layer boundaries. When diagnosing, first establish which layer
produced the wrong value (`stn debug logs "Harness event report"` shows the
normalized result and the projection decision for every ingested event).

## Current Contract (v0)

Normalized events are `HarnessEventReport` / `HarnessEventObservation`
(`packages/contracts/src/hooks.ts`, `observations.ts`):

- `eventType` — free-form string, provider-scoped (e.g. codex `PreToolUse`).
  Core must not branch on it; it exists for correlation, logging, and the TUI's
  event metadata. A closed `signal` taxonomy will supersede it (see Target).
- `status: ObservedStatus` — `value` (working | idle | needs_attention | …),
  `confidence`, `reason` (human prose, display-only), `updatedAt`, and
  `attention`.
- `attention: AttentionKind` — closed enum:
  `question | plan_approval | tool_approval | input`. Set by the provider
  whenever `status.value` is `needs_attention` and the state is a request for
  the user (a question, a plan to approve, a tool/permission gate, any other
  blocking input). This is the only field core/TUI may use to classify
  attention.
- `correlation` — identity for projection, strongest first:
  `harnessRunId` → `sessionId` → `worktreeId` → `cwd`. Providers must attach
  the strongest identity they have; `cwd` alone is a last resort and drops the
  event when ambiguous.
- `reportId` / `coalesceKey` — dedup identity. Two transports reporting the
  same fact must derive the same identity from harness-native ids (e.g. a tool
  `call_id`) so they coalesce instead of racing.

## Invariants

1. **Single normalizer.** One event is normalized by exactly one code version.
   (Today normalization runs in `stn-ingress`; it moves observer-side so a
   stale ingress binary cannot bake stale semantics.)
2. **No provider vocabulary in core.** Observer core and the TUI must not
   match on provider prose (`reason` strings), provider event names, or
   provider keys in `providerData`. If core needs to branch on it, it becomes
   a contract field set at the provider boundary.
3. **Attention is typed.** `needs_attention` without `attention` renders as a
   status but never triggers attention UX (sound, notification). Providers own
   the classification.
4. **Blocking states beat activity.** A tool call that *is* the user request
   (codex `request_user_input`) must normalize as `needs_attention`, not as
   tool activity — the request and the "working" signal must be the same
   event, not a race.
5. **Nothing drops silently.** Every ingested report logs its projection
   decision (`Harness event report processed.` / `skipped.` with
   `projected`/`correlatedBy`/`deduped`). An accepted report with
   `projected: false` is a correlation failure and must stay visible.
6. **Evolution is additive.** New fields optional, enums keep catch-all
   members (`input`), schema stamps (`schemaVersion`) travel with payloads.
   New signal kinds require census evidence, not speculation.
7. **Busy statuses decay.** `working`/`starting` are claims that signals are
   still flowing; reconcile projects a run whose newest signal is older than
   15 minutes to `unknown` (low confidence, source `reconcile`) instead of
   trusting it forever. Attention and idle states never decay, and the next
   real event restores live status.

## Target Taxonomy (HarnessSignal)

A closed `signal` field will supersede free-form `eventType` branching
(additive; `eventType` stays for logging):

- `turn_started | turn_completed | turn_interrupted`
- `attention_opened { kind, requestId, prompt? }`
- `attention_resolved { requestId, outcome: answered | aborted | superseded }`
- `user_message_submitted`
- `tool_started | tool_completed`
- `session_started | session_ended`
- `unclassified { rawEventType }` — retained and counted, never dropped

Semantics: attention is an interval opened and closed by `requestId`
(harness-native identity). A run with an open request is `needs_attention`
regardless of concurrent activity signals; `attention_resolved` closes it and
carries how (`aborted` is not `answered`). `user_message_submitted` clears
stale attention and marks user-driven interruption. Status becomes one pure
fold over signals shared by live projection and reconcile.

## Status Interpretation Today

- Live path: `projectHarnessEventReportOntoSnapshot`
  (`apps/observer/src/reconcile/statusProjection.ts`) applies a report to the
  current snapshot.
- Reconcile path: `applyHarnessEventStatusOverlays`
  (`apps/observer/src/reconcile/harnessEventStatus.ts`) rebuilds from persisted
  observations; the latest correlated overlay wins over the classified run
  status unless the run is confidently exited.
- These are two implementations of one policy; collapsing them into a single
  fold is planned (see invariant 6's spirit: status must be a deterministic
  function of observations).
