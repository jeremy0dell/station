# Harnesses

station observes each agent harness through the hook events it can emit, then derives a single status per session. This page lists what each supported harness can report, how its hooks are delivered, and what it cannot see.

For the ingress mechanics, see [harness-ingress.md](harness-ingress.md). For setup commands and readiness checks, see [Diagnostics](diagnostics.md) and [System dependencies](system-dependencies.md).

## What station observes

station never asks an agent what it is doing. The observer takes the hook events a harness emits, maps each one to an observed status, and projects a single status per session onto the snapshot. The status vocabulary is defined in `packages/contracts/src/observations.ts` (`AgentStateSchema`):

| Status | Meaning |
| -------- | --------- |
| `starting` | The harness session is launching. |
| `working` | The agent is actively running a turn or a tool. |
| `idle` | The agent finished and is waiting for input. The TUI shows **ready** the moment a turn completes and it is safe to prompt. |
| `needs attention` | The agent hit a permission prompt, a notification, or an error that wants you. |
| `exited` | The agent process ended. |
| `stuck` | The agent looks hung or unresponsive. |
| `unknown` | An agent is present but its state cannot be determined. This is also the fallback when a harness cannot report enough. |
| `no agent` | No harness is running on that worktree. |

A harness can only light up the states it can report. That gives two support tiers among the
currently supported harnesses:

- **Full**: reports activity, completion, and attention. Can drive every status.
- **Partial**: reports activity and completion, but has only limited or no attention signals.

## Support at a glance

| Harness | Working | Done | Needs attention | Support | Hooks |
| --------- | :-------: | :----: | :---------------: | --------- | ------- |
| Claude Code | ✓ | ✓ | ✓ | Full | `settings.json` |
| Codex | ✓ | ✓ | ✓ | Full | `~/.codex` `station` profile (TOML) |
| Cursor | ✓ | ✓ | ✓ ¹ | Full | `~/.cursor/hooks.json` |
| OpenCode | ✓ | ✓ | ✓ | Full | plugin |
| Pi | ✓ | ✓ | Limited ² | Partial | in-process extension |

¹ Cursor surfaces attention from a `stop` event with error status, not from a live permission prompt.

² Pi detects the stable prompt-open event from `ask_user_question`, but not
  generic extension dialogs, permission prompts, or plan approval UI.

## Per-harness detail

### Claude Code (Full)

Events (`integrations/harness/claude/src/ingressRules.ts`): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification`, `PreCompact`, `Stop`, `SessionEnd`.

Hooks: station writes entries into Claude's `settings.json` that call a generated `station-claude-hook.sh` script, which forwards events to the observer through `stn-ingress`.

Coverage: full. `PermissionRequest` and `Notification` drive **needs attention**, `Stop` drives **idle**, and `SessionStart`/`SessionEnd` drive **starting**/**exited**.

### Codex (Full)

Events (`integrations/harness/codex/src/ingressRules.ts`): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `Stop`.

Hooks: a dedicated `station` profile (`station.config.toml`) under `~/.codex` calls `station-codex-hook.sh`.

Coverage: full. `PermissionRequest` drives **needs attention**, a completed `Stop` drives **idle**, and `stop_hook_active` keeps **working**. Codex has no session-end hook, so **exited** is inferred from process state.

### Cursor (Full)

Events (`integrations/harness/cursor/src/hooks/hookConstants.ts`): `sessionStart`, `stop`, `sessionEnd`, `beforeShellExecution`, `afterShellExecution`, `preToolUse`, `postToolUse`, `postToolUseFailure`.

Hooks: entries in `~/.cursor/hooks.json` call `station-cursor-hook.sh`.

Coverage: full, with one nuance. Attention comes from a `stop` event whose status is `error`, rather than from a live permission prompt. A `stop` with `completed` or `aborted` drives **idle**, and `sessionEnd` drives **exited**.

### OpenCode (Full)

Events (`integrations/harness/opencode/src/ingressRules.ts`): a rich plugin stream including `session.created`, `session.idle`, `session.error`, `session.deleted`, `permission.asked`, `permission.replied`, `question.asked`, `question.replied`, tool-execution events, and compaction events.

Hooks: an OpenCode plugin forwards events to the observer.

Coverage: full, and the richest of the set. `permission.asked`, `question.asked`, and `session.error` drive **needs attention**; `session.idle` drives **idle**; `session.deleted` drives **exited**.

### Pi (Partial)

Events (`integrations/harness/pi/src/event/catalog.ts`): `session_start`,
`session_shutdown`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`,
`tool_execution_start`, `tool_execution_end`, `message_end`, `session_compact`,
plus the Station-derived `question_prompt_open` edge.

Hooks: Pi loads an in-process station extension, so there is no external config
file. Reports spool to the observer socket, or to disk when the observer is
unavailable. Station requires Pi `0.80.5` or newer and reports older or
unparseable versions as unavailable because they lack the required settlement
edge.

Coverage: partial. An `ask_user_question` tool start is only preflight and
remains **working**. Its stable prompt-open event drives **needs attention**
with question intent; unrelated parallel tool events preserve that attention
until the matching question ends. A question rejected before prompt-open never
reports attention. The matching tool end returns to **working** whether the
prompt was answered or cancelled.

Settlement-aware producers mark `agent_end` as **working** because Pi may retry,
compact, or run a queued continuation; `agent_settled` drives **idle** and
completed-turn readiness. Markerless legacy reports retain their historical
`agent_end` completion behavior so already-running sessions do not remain
falsely busy during an upgrade. A completed manual compaction can also drive
**idle**, while threshold, overflow, and legacy compaction remain **working**
until settlement. Quit shutdown drives **exited**.

Pi has no universal typed event for extension dialogs, permission prompts, or
plan approval UI, so those remain invisible. Question prose and options never
leave the Pi adapter and are never classified as plan intent.

## Installing hooks

Every harness except Pi is wired up the same way:

```sh
stn hooks doctor <harness>     # is the hook installed and current?
stn hooks install <harness>    # write or update the hook
stn hooks uninstall <harness>  # remove it
```

`<harness>` is one of `claude`, `codex`, `cursor`, or `opencode`. Pi needs no install step because its extension loads in-process. `stn doctor` reports the status of every configured harness.
