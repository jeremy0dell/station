# Harness Startup Evidence

Status: living record for provider startup readiness evidence.

Station distinguishes three facts:

1. `signal.kind: session_started` proves provider-native lifecycle creation.
2. `status.value: idle` without turn completion proves the provider is ready for input.
3. `turn.kind: turn_completed` proves assistant output completed and may create durable `ready_to_read` evidence.

A session start never implies a completed turn. Startup idle renders the same ready-for-input affordance without creating a completed-turn acknowledgement token or firing completed-turn notification hooks. Providers remain `starting` unless a native event or documented provider invariant proves input readiness; Station has no timer fallback.

## Required census

For every supported provider release, capture these scenarios before changing its startup status mapping:

- launch without an initial prompt and wait until the native prompt is usable;
- launch with an initial prompt through completion;
- deterministic initialization failure or exit before the trusted ready edge.

Record the CLI version, intervening trust/auth/model/setup UI, native event order, normalized signal/status/turn sequence, final snapshot, and whether attention or turn readiness appeared. Committed fixtures must omit prompt text, transcript content, credentials, and machine-specific paths.

## Issue 292 baseline

Runtime inspection used `stn debug logs "Harness event report"`, `stn observe --include-snapshot --duration 3s --json`, `stn snapshot --json --include-debug`, and provider hook doctors before source inspection.

| Provider | Version | Proven startup-ready edge | Conservative result |
| --- | --- | --- | --- |
| Claude Code | 2.1.216 | `Notification(idle_prompt)` when emitted | `SessionStart` stays `starting`; a pristine launch without `idle_prompt` remains busy and may decay to `unknown`. |
| Codex CLI | 0.145.0 | None before first-turn processing | `SessionStart` stays `starting`; no timer fallback. |
| Cursor Agent | 2026.07.09-a3815c0 | None from `sessionStart` documentation | `sessionStart` stays `starting`; `beforeSubmitPrompt` proves working. |
| OpenCode | 1.16.2 | `session.status` with native status `idle` | `session.created` stays `starting`; whether every pristine launch emits status-idle remains an opt-in real-lane question. |
| Pi | 0.81.1 | `session_start` after focused UI startup and buffered submit installation | `session_start` maps to startup idle with no completed-turn marker. |

Authenticated, isolated three-scenario captures remain unresolved for Claude, Codex, Cursor, and OpenCode. Their lifecycle hooks therefore remain `starting`; no elapsed-time inference was introduced. Deterministic sanitized sequences live in each integration's `test/fixtures/startup-sequences.json`, and opt-in real lanes are the place to refresh the evidence against installed CLIs.

## OpenCode completion evidence

OpenCode's plugin tracks provider-native session activity before forwarding `session.idle`. The compact provider payload carries `turn_activity_observed`; only idle after proven activity normalizes to `turn_completed`. Startup idle without activity remains plain idle and cannot create completed-turn readiness.
