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
  `harnessRunId` → bound `nativeSessionId` → `sessionId` → `worktreeId` →
  `cwd`. Providers must attach the strongest identity they have; `cwd` alone
  is a last resort and drops the event when ambiguous. Station session and
  worktree IDs route evidence to a run but do not identify the provider-native
  execution within that run. When a provider's own native ids are not stable
  across hook types, the adapter must emit pane-stable `nativeSessionId` equal
  to `harnessRunId` once Station terminal identity is present. Station IDs
  inherited through the process environment are strong only after
  provider-origin evidence corroborates them; Codex requires its observed cwd
  to be the stamped worktree path or an ordinary descendant without crossing
  into the configured managed-worktree root when that launch context is
  available.
- `diagnostics.correlationIssue` — optional provider-normalized,
  machine-readable evidence explaining why identity was withheld. The current
  value is `station_identity_cwd_mismatch`; core records and logs it but does
  not branch on provider vocabulary.
- `reportId` / `coalesceKey` — dedup identity. Two transports reporting the
  same fact must derive the same identity from harness-native ids (e.g. a tool
  `call_id`) so they coalesce instead of racing.

## Invariants

1. **Single normalizer.** One event is normalized by exactly one adapter
   version. Raw events delivered by `stn-ingress` normalize observer-side
   through the selected provider hook adapter, so a stale ingress binary cannot
   bake stale semantics. An integration that submits an already-typed
   `HarnessEventReport` instead normalizes in its own adapter and is not
   normalized again by the observer. Shipped Pi and OpenCode hook transports
   use the raw `stn-ingress` path. `HarnessProvider` has no fallback raw-event
   ingestion operation; cwd-only and other unresolved report evidence is
   correlated against current graph truth only during Observer projection.
2. **No provider vocabulary in core.** Observer core and the TUI must not
   match on provider prose (`reason` strings), provider event names, or
   provider keys in `providerData`. If core needs to branch on it, it becomes
   a contract field set at the provider boundary.
3. **Attention is typed.** `needs_attention` without `attention` renders as a
   status but never triggers attention UX (sound, notification). Providers own
   the classification. The OpenCode transport applies one provider-owned
   carveout: it suppresses a `permission.asked` event when OpenCode's own
   auto-accept resolves it with a matching `permission.replied` before the
   ask's 300 ms confirmation window expires, because such an ask never blocked
   a user. A genuine ask (no reply within the window) is forwarded unchanged
   and opens attention as usual. Codex `PermissionRequest` has no reviewer field
   or resolution identity. Its adapter therefore uses only a strictly parsed,
   matching `turn_context` from the bounded provider transcript tail to recognize
   `auto_review`, and reads that transcript only after Station correlation admits
   the hook. A malformed newest matching context makes the evidence unavailable;
   the adapter never falls back to an older reviewer. Unavailable or changed
   transcript evidence remains a real `needs_attention` signal rather than risking
   a hidden user approval.
4. **Blocking states beat activity.** A tool call that *is* the user request
   (Codex `request_user_input`) must normalize as `needs_attention`, not as
   tool activity. When a provider separates prompt-open from tool preflight,
   sibling activity must carry the active request identity until its matching
   resolution instead of clearing attention.
5. **Nothing drops silently.** Every ingested report logs its projection
   decision (`Harness event report processed.` / `skipped.` with
   `projected`/`correlatedBy`/`deduped`). An accepted report with
   `projected: false` is a correlation failure and must stay visible.
6. **Evolution is explicit.** Prefer optional fields and keep enum catch-all
   members (`input`). Schema stamps (`schemaVersion`) travel with payloads, and
   any required shared-shape change bumps the exact `STATION_SCHEMA_VERSION`.
   After such a bump, reinstall the binary and rerun `stn setup` or
   `stn hooks install <target> --yes` for every enabled provider before testing
   ingress. New signal kinds require census evidence, not speculation.
7. **Busy statuses decay.** `working`/`starting` are claims that signals are
   still flowing; reconcile projects a run whose newest signal is older than
   15 minutes to `unknown` (low confidence, source `reconcile`) instead of
   trusting it forever. Attention and idle states never decay, and the next
   real event restores live status.
8. **Native completion fails closed.** Active evidence may bind an unbound
   provider plus Station session to one native execution. A `starting` binding
   is provisional: non-stale `working` or `needs_attention` evidence may promote
   a different native execution, while another startup or completion cannot.
   Once activity or attention establishes the execution, replacement requires
   explicit `idle` or `exited` evidence. Mismatched evidence remains
   diagnostic-only and cannot derive recovery, readiness, projected state
   changes, or completion notifications. Worktree-only external sessions remain
   independently keyed by native identity, and idle/completion evidence never
   establishes a binding.
   Pane-scoped native identity (`nativeSessionId` equal to `harnessRunId`) is the
   same execution as the Station-launched pane run, so it may replace an active
   conversation-scoped binding on that session; stale evidence still fails closed.
9. **Inherited identity is corroborated.** A provider must withhold inherited
   Station project, worktree, session, terminal, and run correlation when its
   own origin evidence contradicts the Station stamp. It retains provider-native
   identity and diagnostic origin evidence so the report remains inspectable.
10. **Native settlement outranks low-level completion.** A producer that marks
    itself settlement-aware keeps each low-level run end `working` because
    retries, automatic compaction, or queued follow-ups may continue. Automatic
    compaction completion likewise remains `working`; only the native settled
    edge may mark the completed turn `idle` and ready. Markerless legacy
    producers retain their historical low-level completion semantics during a
    rolling upgrade.
11. **Startup evidence revalidates health; it does not define it.** After an
    accepted, projected report with normalized status `starting`, Observer
    eagerly re-probes that provider only when current health is `unavailable`.
    The authoritative probe result updates health; startup traffic never assigns
    `healthy`, `idle`, or turn readiness directly.
12. **Hook health is read-only evidence.** Consumers such as diagnostics and
    status presentation may read the strict provider-neutral `hookHealth()`
    result but must never turn that read into reconciliation. Mutation is a
    separate provider-owned capability invoked only by authorized setup,
    update, startup, launch, or resume orchestration; hook signals themselves
    never repair installation state.

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

- Run discovery returns a `HarnessRunObservation` whose `status` is already
  normalized at the provider boundary. `observedAt` timestamps the inventory
  observation; `status.updatedAt` timestamps the status evidence it carries.
- Live path: `projectHarnessEventReportOntoSnapshot`
  (`apps/observer/src/reconcile/statusProjection.ts`) applies a report to the
  current snapshot.
- Reconcile path: `applyHarnessEventStatusOverlays`
  (`apps/observer/src/reconcile/harnessEventStatus.ts`) rebuilds from persisted
  observations; the latest correlated overlay wins over the discovered run
  status unless the run is confidently exited.
- These are two implementations of one policy; collapsing them into a single
  fold is planned (see invariant 6's spirit: status must be a deterministic
  function of observations).
