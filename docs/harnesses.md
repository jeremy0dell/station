# Harnesses

station observes each agent harness through the hook events it can emit, then derives a single status per session. This page lists what each supported harness can report, how its hooks are delivered, and what it cannot see.

For the ingress mechanics, see [harness-ingress.md](harness-ingress.md). For setup commands and readiness checks, see [Diagnostics](diagnostics.md) and [System dependencies](system-dependencies.md).

## What station observes

station never asks an agent what it is doing. The observer takes the hook events a harness emits, maps each one to an observed status, and projects a single status per session onto the snapshot. The status vocabulary is defined in `packages/contracts/src/observations.ts` (`AgentStateSchema`):

| Status | Meaning |
|--------|---------|
| `starting` | The harness session is launching. |
| `working` | The agent is actively running a turn or a tool. |
| `idle` | The agent finished and is waiting for input. The TUI shows **ready** the moment a turn completes and it is safe to prompt. |
| `needs attention` | The agent hit a permission prompt, a notification, or an error that wants you. |
| `exited` | The agent process ended. |
| `stuck` | The agent looks hung or unresponsive. |
| `unknown` | An agent is present but its state cannot be determined. This is also the fallback when a harness cannot report enough. |
| `no agent` | No harness is running on that worktree. |

A harness can only light up the states it can report. That gives three support tiers:

- **Full**: reports activity, completion, and attention. Can drive every status.
- **Partial**: reports activity and completion, but has no attention signal.
- **Minimal**: can only infer that work is happening; status otherwise falls back to process liveness (running vs exited).

## Support at a glance

| Harness | Working | Done | Needs attention | Support | Hooks |
|---------|:-------:|:----:|:---------------:|---------|-------|
| Claude Code | ✓ | ✓ | ✓ | Full | `settings.json` |
| Codex | ✓ | ✓ | ✓ | Full | `~/.codex` `station` profile (TOML) |
| Cursor | ✓ | ✓ | ✓ ¹ | Full | `~/.cursor/hooks.json` |
| OpenCode | ✓ | ✓ | ✓ | Full | plugin |
| Pi | ✓ | ✓ | ✗ | Partial | in-process extension |
| Crush | ~ | ✗ | ✗ | Minimal | `.crush.json` (`PreToolUse`) |

¹ Cursor surfaces attention from a `stop` event with error status, not from a live permission prompt.

## Per-harness detail

### Claude Code (Full)

Events (`integrations/harness/claude/src/ingressRules.ts`): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification`, `PreCompact`, `Stop`, `SessionEnd`.

Hooks: station writes entries into Claude's `settings.json` that call a generated `station-claude-hook.sh` script, which forwards events to the observer through `stn-ingress`.

Coverage: full. `PermissionRequest` and `Notification` drive **needs attention**, `Stop` drives **idle**, and `SessionStart`/`SessionEnd` drive **starting**/**exited**.

### Codex (Full)

Events (`integrations/harness/codex/src/hooks/hookConstants.ts`): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`.

Hooks: a dedicated `station` profile (`station.config.toml`) under `~/.codex` calls `station-codex-hook.sh`.

Coverage: full. `PermissionRequest` drives **needs attention** and `Stop` drives **idle**. Codex has no session-end hook, so **exited** is inferred from process state.

### Cursor (Full)

Events (`integrations/harness/cursor/src/hooks/hookConstants.ts`): `sessionStart`, `stop`, `sessionEnd`, `beforeShellExecution`, `afterShellExecution`, `preToolUse`, `postToolUse`, `postToolUseFailure`.

Hooks: entries in `~/.cursor/hooks.json` call `station-cursor-hook.sh`.

Coverage: full, with one nuance. Attention comes from a `stop` event whose status is `error`, rather than from a live permission prompt. A `stop` with `completed` or `aborted` drives **idle**, and `sessionEnd` drives **exited**.

### OpenCode (Full)

Events (`integrations/harness/opencode/src/ingressRules.ts`): a rich plugin stream including `session.created`, `session.idle`, `session.error`, `session.deleted`, `permission.asked`, `permission.replied`, `question.asked`, `question.replied`, tool-execution events, and compaction events.

Hooks: an OpenCode plugin forwards events to the observer.

Coverage: full, and the richest of the set. `permission.asked`, `question.asked`, and `session.error` drive **needs attention**; `session.idle` drives **idle**; `session.deleted` drives **exited**.

### Pi (Partial)

Events (`integrations/harness/pi/src/event/catalog.ts`): `session_start`, `session_shutdown`, `agent_start`, `agent_end`, `turn_start`, `tool_execution_start`, `tool_execution_end`, `message_end`, `session_compact`.

Hooks: Pi loads an in-process station extension, so there is no external config file. Reports spool to the observer socket, or to disk when the observer is unavailable.

Coverage: partial. Lifecycle and activity are covered (`agent_end` maps to **idle**, `session_shutdown` to **exited**), but Pi emits no permission or notification event, so it never reports **needs attention**.

### Crush (Minimal)

Events (`integrations/harness/crush/src/hooks.ts`): `PreToolUse` only.

Hooks: a station entry under `hooks.PreToolUse` in `.crush.json` calls `station-crush-hook.sh` (30s timeout; the script exits 0 with empty output so Crush never treats it as blocking a tool).

Coverage: minimal. Crush exposes no completion signal (`integrations/harness/crush/src/provider.ts` sets `canStop: false`), so a running Crush session resolves to `unknown` ("Crush run has no reliable Crush status signal yet"). station can tell that a tool is about to run, but not when Crush finishes, goes idle, or needs you. Status otherwise relies on process liveness.

## Installing hooks

Every harness except Pi is wired up the same way:

```sh
stn hooks doctor <harness>     # is the hook installed and current?
stn hooks install <harness>    # write or update the hook
stn hooks uninstall <harness>  # remove it
```

`<harness>` is one of `claude`, `codex`, `cursor`, `opencode`, or `crush`. Pi needs no install step because its extension loads in-process. `stn doctor` reports the status of every configured harness.
