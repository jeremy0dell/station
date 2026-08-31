import {
  externalCommandErrorFromUnknown,
  type RuntimeSafeError,
  safeErrorFromUnknown,
} from "@station/runtime";
import { describe, expect, it } from "vitest";
import {
  isWorktrunkConcurrentCreateRegistryFailure,
  worktrunkCommandFailure,
} from "../../src/commandFailure.js";
import { WorktrunkProviderError } from "../../src/errors.js";

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
        {
          command: "wt",
          args: ["switch", "--create", "feature"],
          cwd: "/tmp/project",
          env: { PATH: "/observer/bin:/usr/bin" },
        },
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

  it("retains missing-command PATH evidence while enriching the failure", () => {
    const normalized = safeErrorFromUnknown(
      externalCommandErrorFromUnknown(Object.assign(new Error("not found"), { code: "ENOENT" }), {
        command: "wt",
        args: ["list"],
        cwd: "/tmp/project",
        env: { PATH: "/observer/bin:/usr/bin" },
      }),
      {
        tag: "WorktreeProviderError",
        code: fallback.code,
        message: fallback.message,
        provider: "worktrunk",
      },
    );

    expect(mapFailure(normalized).diagnosticDetails).toEqual([
      expect.objectContaining({
        type: "external_command",
        provider: "worktrunk",
        operation: "provider.worktrunk.switch",
        pathEnv: "/observer/bin:/usr/bin",
      }),
    ]);
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

  it("recognizes only the nested Git sibling-registration create race", () => {
    for (const missingFile of ["No such file or directory", "Undefined error: 0"]) {
      const race = registryCreateFailure([
        "Failed to create worktree for feature from base main",
        `fatal: failed to read .git/worktrees/sibling/commondir: ${missingFile}`,
        "Failed command, exit code 128:",
        "git worktree add -b feature -- /tmp/project/feature main",
      ]);
      expect(isWorktrunkConcurrentCreateRegistryFailure(race, "feature")).toBe(true);
    }

    for (const ordinaryFailure of [
      "Permission denied",
      "Input/output error",
      "Operation not permitted",
    ]) {
      const failure = registryCreateFailure([
        "Failed to create worktree for feature from base main",
        `fatal: failed to read .git/worktrees/sibling/commondir: ${ordinaryFailure}`,
        "Failed command, exit code 128:",
        "git worktree add -b feature -- /tmp/project/feature main",
      ]);
      expect(isWorktrunkConcurrentCreateRegistryFailure(failure, "feature")).toBe(false);
    }

    const ownRegistration = registryCreateFailure([
      "Failed to create worktree for feature from base main",
      "fatal: failed to read .git/worktrees/feature/commondir: No such file or directory",
      "Failed command, exit code 128:",
      "git worktree add -b feature -- /tmp/project/feature main",
    ]);
    expect(isWorktrunkConcurrentCreateRegistryFailure(ownRegistration, "feature")).toBe(false);

    const mismatchedCreate = registryCreateFailure([
      "Failed to create worktree for other from base main",
      "fatal: failed to read .git/worktrees/sibling/commondir: No such file or directory",
      "Failed command, exit code 128:",
      "git worktree add -b other -- /tmp/project/other main",
    ]);
    expect(isWorktrunkConcurrentCreateRegistryFailure(mismatchedCreate, "feature")).toBe(false);
  });
});

function registryCreateFailure(stderr: string[]): WorktrunkProviderError {
  const failure = mapFailure(
    safeErrorFromUnknown(
      externalCommandErrorFromUnknown(
        Object.assign(new Error("wt failed"), { code: 128, stderr: stderr.join("\n") }),
        {
          command: "wt",
          args: ["switch", "--create", "feature"],
          cwd: "/tmp/project",
        },
      ),
      {
        tag: "WorktreeProviderError",
        code: fallback.code,
        message: fallback.message,
        provider: "worktrunk",
      },
    ),
  );
  if (!(failure instanceof WorktrunkProviderError)) {
    throw new Error("Expected a Worktrunk provider failure.");
  }
  return failure;
}
