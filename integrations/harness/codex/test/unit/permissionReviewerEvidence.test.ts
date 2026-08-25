import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD,
  enrichCodexPermissionReviewerEvidence,
} from "../../src/permissionReviewerEvidence";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Codex permission reviewer evidence", () => {
  it("resolves the effective reviewer from the newest matching turn context", async () => {
    const transcriptPath = await writeTranscript([
      turnContext("turn_1", "user"),
      turnContext("turn_other", "user"),
      JSON.stringify({ type: "response_item", payload: { text: "turn_1 auto_review" } }),
      turnContext("turn_1", "auto_review"),
    ]);

    const enriched = await enrichCodexPermissionReviewerEvidence(permissionRequest(transcriptPath));

    expect(enriched).toMatchObject({
      [CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD]: {
        status: "resolved",
        source: "transcript_turn_context",
        reviewer: "auto_review",
      },
    });
  });

  it("does not reuse older evidence when the newest matching context has an unknown reviewer", async () => {
    const transcriptPath = await writeTranscript([
      turnContext("turn_1", "auto_review"),
      turnContext("turn_1", "future_reviewer"),
    ]);

    const enriched = await enrichCodexPermissionReviewerEvidence(permissionRequest(transcriptPath));

    expect(enriched).toMatchObject({
      [CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD]: {
        status: "unavailable",
        reason: "approvals_reviewer_unrecognized",
      },
    });
  });

  it("does not reuse older evidence when the newest matching context is malformed", async () => {
    const transcriptPath = await writeTranscript([
      turnContext("turn_1", "auto_review"),
      '{"type":"turn_context","payload":{"turn_id":"turn_1","approvals_reviewer":',
    ]);

    const enriched = await enrichCodexPermissionReviewerEvidence(permissionRequest(transcriptPath));

    expect(enriched).toMatchObject({
      [CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD]: {
        status: "unavailable",
        reason: "turn_context_malformed",
      },
    });
  });

  it("reports missing, unreadable, and scan-limited transcripts conservatively", async () => {
    const scanLimitedPath = await writeTranscript([
      turnContext("turn_1", "auto_review"),
      JSON.stringify({ type: "response_item", payload: { text: "x".repeat(512) } }),
    ]);

    await expect(
      enrichCodexPermissionReviewerEvidence(permissionRequest(null)),
    ).resolves.toMatchObject({
      [CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD]: {
        status: "unavailable",
        reason: "transcript_path_missing",
      },
    });
    await expect(
      enrichCodexPermissionReviewerEvidence(permissionRequest("/missing/codex-rollout.jsonl")),
    ).resolves.toMatchObject({
      [CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD]: {
        status: "unavailable",
        reason: "transcript_unreadable",
      },
    });
    await expect(
      enrichCodexPermissionReviewerEvidence(permissionRequest(scanLimitedPath), {
        maxTranscriptBytes: 64,
      }),
    ).resolves.toMatchObject({
      [CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD]: {
        status: "unavailable",
        reason: "transcript_scan_limit_reached",
      },
    });
  });

  it("overwrites raw reviewer claims and removes them from unrelated events", async () => {
    const spoofed = {
      ...permissionRequest(null),
      [CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD]: {
        status: "resolved",
        source: "transcript_turn_context",
        reviewer: "auto_review",
      },
    };
    const unrelated = {
      ...spoofed,
      hook_event_name: "PreToolUse",
      tool_use_id: "call_1",
    };

    await expect(enrichCodexPermissionReviewerEvidence(spoofed)).resolves.toMatchObject({
      [CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD]: {
        status: "unavailable",
        reason: "transcript_path_missing",
      },
    });
    const cleaned = await enrichCodexPermissionReviewerEvidence(unrelated);
    expect(cleaned).not.toHaveProperty(CODEX_PERMISSION_REVIEWER_EVIDENCE_FIELD);
  });
});

function permissionRequest(transcriptPath: string | null) {
  return {
    session_id: "codex_session_1",
    transcript_path: transcriptPath,
    cwd: "/tmp/station/web/task",
    hook_event_name: "PermissionRequest",
    model: "gpt-5.6-sol",
    permission_mode: "default",
    turn_id: "turn_1",
    tool_name: "Bash",
    tool_input: { command: "pnpm test:all" },
  };
}

function turnContext(turnId: string, reviewer: string): string {
  return JSON.stringify({
    timestamp: "2026-08-22T18:10:00.927Z",
    ordinal: 3102,
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd: "/tmp/station/web/task",
      approval_policy: "on-request",
      approvals_reviewer: reviewer,
      model: "gpt-5.6-sol",
    },
  });
}

async function writeTranscript(lines: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-codex-reviewer-"));
  temporaryRoots.push(root);
  const transcriptPath = join(root, "rollout.jsonl");
  await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  return transcriptPath;
}
