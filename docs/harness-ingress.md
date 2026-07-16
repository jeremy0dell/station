# Harness Ingress

Status: current guidance for harness event admission into the observer.

## Allow-List Policy

Harness integrations should admit only provider-rule-allowed event types into observer ingress. Unknown or unlisted provider events are dropped at the earliest provider boundary, before delivery, spool, queueing, normalization, or reconcile scheduling.

This is intentionally an allow-list, not a catalog of dropped events. Provider event streams can include high-frequency or diagnostic events that do not contribute useful observer state. Requiring every dropped event to be modeled would couple STATION to provider internals and make the boundary harder to maintain.

## Rationale

The observer is a shared runtime path. Event ingress should preserve useful state transitions while avoiding avoidable queue pressure and wasted work.

The policy follows common overload and messaging guidance:

- Drop unneeded work early and cheaply instead of accepting it into queues.
- Keep queues short so latency does not turn into timeout-driven failure.
- Treat ingress as a message filter: matching messages continue, non-matching messages are discarded.
- Preserve visibility for accepted events through profiling, queue depth, spool depth, and diagnostics.

## Contract Shape

Contracts define the generic ingress rule shape. Provider integrations own their provider-specific rule tables beside their adapters/parsers. A rule identifies the native provider event type and optional normalized status metadata. Absence from the provider rule table means implicit drop.

```ts
export type HarnessIngressRule<Provider extends string, EventType extends string> = {
  provider: Provider;
  eventType: EventType;
  statusIntents?: readonly HarnessStatusIntent[];
  confidences?: readonly HarnessStatusConfidence[];
};
```

Provider integrations derive their forwarding allow-list from their local rules. Generated plugins must serialize the derived allow-list rather than maintaining independent copies.

## Transport Ownership

Generated first-party hook transports, including Pi and OpenCode, invoke
`stn-ingress` instead of opening the Observer socket or writing spool records
themselves. The CLI ingress path verifies the accepted Observer build, owns
auto-start and offline spooling, and rejects known build, schema, or handoff
incompatibility without putting the event into a spool that mismatched code can
drain. Raw hook payloads normalize exactly once through the selected
Observer-side provider adapter; an already-normalized `HarnessEventReport`
bypasses that adapter.

## Rollout

OpenCode is the first provider using a rule-derived ingress filter. Claude Code follows the same shape: `integrations/harness/claude/src/ingressRules.ts` is the single source of truth for both the installed hook event set (the generated `--settings` artifact registers only rule-listed events) and status projection (`statusFromClaudeHookEvent` is gated by rule presence, and `stn-ingress claude` drops unlisted event types with an `ignored` receipt). `SubagentStart`, `SubagentStop`, and `PostToolUseFailure` are deliberately absent from the Claude rules: `SubagentStop` fires after `Stop` at turn end and would flip a freshly idle row back to working. Codex and Pi must keep current behavior until each has provider-specific ingress rules and no-regression tests proving required events are still admitted.

When adding a provider:

- Add provider-specific rules beside the provider adapter/parser.
- Derive the provider hook/plugin allow-list from those rules.
- Add tests that noisy stream events are not forwarded when omitted.
- Add tests that every status-producing normalizer branch maps to an allowed rule.
- Validate live observer profiling: spool depth, ingress queue depth, `drainMs`, `publishMs`, and timeout/error records.
