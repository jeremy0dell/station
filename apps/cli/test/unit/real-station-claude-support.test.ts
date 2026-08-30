import { describe, expect, it } from "vitest";
import { claudeSessionStartWitnessFromAttempts } from "../../../../tests/support/real-station/claude.js";

describe("real Station Claude support", () => {
  it("parses an exact Claude SessionStart witness and retains its injected settings artifact", () => {
    const witness = claudeSessionStartWitnessFromAttempts(
      [
        {
          id: "00000000-0000-4000-8000-000000000001",
          invokedAt: "2026-01-01T00:00:00.000Z",
          argv: ["claude"],
          rawInput: JSON.stringify({
            session_id: "native-claude-1",
            transcript_path: "/private/claude.jsonl",
            cwd: "/repo/worktree",
            permission_mode: "bypassPermissions",
            hook_event_name: "SessionStart",
            source: "startup",
            newly_added_upstream_field: true,
          }),
          exitStatus: 0,
          signal: null,
          stdout: '{"accepted":true}',
          stderr: "",
        },
      ],
      {
        hooks: { settingsPath: "/repo/.claude/settings.json", hookScriptPath: "/private/hook.sh" },
        cwd: "/repo/worktree",
        source: "startup",
      },
    );

    expect(witness).toMatchObject({
      provider: "claude",
      target: { kind: "native-session", id: "native-claude-1" },
      mode: "interactive",
      source: "startup",
      settingsArtifact: "/repo/.claude/settings.json",
      hooks: { settingsPath: "/repo/.claude/settings.json", hookScriptPath: "/private/hook.sh" },
      delivery: { exitStatus: 0, stdout: '{"accepted":true}' },
    });
  });

  it("rejects failed delivery and mismatched native identities", () => {
    const attempt = {
      id: "00000000-0000-4000-8000-000000000001",
      invokedAt: "2026-01-01T00:00:00.000Z",
      argv: ["claude"],
      rawInput: JSON.stringify({
        session_id: "native-claude-1",
        cwd: "/repo/worktree",
        hook_event_name: "SessionStart",
        source: "resume",
      }),
      exitStatus: 1,
      signal: null,
      stdout: "",
      stderr: "failed",
    };
    expect(
      claudeSessionStartWitnessFromAttempts([attempt], {
        hooks: { settingsPath: "/settings.json", hookScriptPath: "/hook.sh" },
      }),
    ).toBeUndefined();
    expect(
      claudeSessionStartWitnessFromAttempts([{ ...attempt, exitStatus: 0 }], {
        hooks: { settingsPath: "/settings.json", hookScriptPath: "/hook.sh" },
        nativeSessionId: "native-other",
      }),
    ).toBeUndefined();
  });
});
