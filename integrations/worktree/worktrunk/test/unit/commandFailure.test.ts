import {
  externalCommandErrorFromUnknown,
  type RuntimeSafeError,
  safeErrorFromUnknown,
} from "@station/runtime";
import { describe, expect, it } from "vitest";
import { worktrunkCommandFailure } from "../../src/commandFailure.js";

const fallback = {
  code: "WORKTRUNK_COMMAND_FAILED" as const,
  message: "Worktrunk failed to create a worktree.",
};

function mapFailure(error: RuntimeSafeError) {
  return worktrunkCommandFailure({
    error,
    provider: "worktrunk",
    operation: "provider.worktrunk.switch",
    command: "wt",
    args: ["switch", "--create", "feature"],
    cwd: "/tmp/project",
    durationMs: 12,
    fallback,
    installHint: "Install Worktrunk.",
  });
}

describe("Worktrunk command failure mapping", () => {
  it("enriches redacted typed command evidence and classifies branch conflicts", () => {
    const normalized = safeErrorFromUnknown(
      externalCommandErrorFromUnknown(
        {
          code: 128,
          signal: "SIGTERM",
          stdout: "progress",
          stderr: "fatal: branch feature already exists OPENAI_TOKEN=secret-value",
        },
        { command: "wt", args: ["switch", "--create", "feature"], cwd: "/tmp/project" },
      ),
      {
        tag: "WorktreeProviderError",
        code: fallback.code,
        message: fallback.message,
        provider: "worktrunk",
      },
    );

    const mapped = mapFailure(normalized);

    expect(mapped).toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_BRANCH_EXISTS",
      message: "Worktrunk could not create the worktree because the branch already exists.",
      diagnosticDetails: [
        {
          type: "external_command",
          provider: "worktrunk",
          operation: "provider.worktrunk.switch",
          command: "wt switch --create feature",
          cwd: "/tmp/project",
          exitCode: 128,
          signal: "SIGTERM",
          stdoutSnippet: "progress",
          stderrSnippet: "fatal: branch feature already exists OPENAI_TOKEN=[REDACTED]",
          durationMs: 12,
        },
      ],
    });
    expect(mapped.cause).toBe(normalized);
    expect(JSON.stringify(mapped)).not.toContain("secret-value");
  });

  it("distinguishes a missing binary from a missing working directory", () => {
    const missingBinary = mapFailure({
      tag: "ExternalCommandError",
      code: "ENOENT",
      message: "External command failed.",
    });
    expect(missingBinary).toMatchObject({
      tag: "ProviderUnavailableError",
      code: "WORKTRUNK_UNAVAILABLE",
      message: "Worktrunk is not available.",
      hint: "Install Worktrunk.",
    });

    const missingCwd = mapFailure({
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_CWD_NOT_FOUND",
      message: "External command failed.",
    });
    expect(missingCwd).toMatchObject({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_COMMAND_FAILED",
      message: fallback.message,
    });
  });

  it("maps timeout and cancellation from normalized codes", () => {
    expect(
      mapFailure({
        tag: "TimeoutError",
        code: "WORKTRUNK_TIMEOUT",
        message: "Worktrunk command timed out.",
      }),
    ).toMatchObject({ code: "WORKTRUNK_TIMEOUT", message: "Worktrunk command timed out." });
    expect(
      mapFailure({
        tag: "ExternalCommandError",
        code: "EXTERNAL_COMMAND_ABORTED",
        message: "External command was aborted.",
      }),
    ).toMatchObject({
      code: "WORKTRUNK_CANCELLED",
      message: "Worktrunk command was cancelled.",
    });
  });
});
