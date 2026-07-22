import {
  externalCommandDiagnosticFromSafeError,
  publicSafeErrorFromUnknown,
  type RuntimeSafeError,
  safeErrorFromUnknown,
} from "@station/runtime";
import { describe, expect, it } from "vitest";

const fallback = {
  tag: "RuntimeError",
  code: "RUNTIME_FAILED",
  message: "Runtime failed.",
};

const commandDiagnostic = {
  type: "external_command" as const,
  provider: "worktrunk",
  operation: "provider.worktrunk.switch",
  command: "wt switch feature",
  cwd: "/tmp/project",
  exitCode: 1,
  stderrSnippet: "failed",
};

describe("runtime safe error normalization", () => {
  it("preserves the outer safe error while inheriting nested typed diagnostics", () => {
    const inner = Object.assign(new Error("inner"), {
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_FAILED",
      command: "wt switch feature",
      diagnosticDetails: [commandDiagnostic],
    });
    const outer = Object.assign(new Error("Worktrunk failed to switch worktrees."), {
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_COMMAND_FAILED",
      cause: inner,
    });

    expect(safeErrorFromUnknown(outer, fallback)).toEqual({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_COMMAND_FAILED",
      message: "Worktrunk failed to switch worktrees.",
      diagnosticDetails: [commandDiagnostic],
    });
  });

  it("deduplicates typed diagnostics inherited through nested safe causes", () => {
    const inner = {
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_FAILED",
      message: "External command failed.",
      command: "wt switch feature",
      diagnosticDetails: [commandDiagnostic],
    };
    const outer = {
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_COMMAND_FAILED",
      message: "Worktrunk failed to switch worktrees.",
      diagnosticDetails: [commandDiagnostic],
      cause: inner,
    };

    expect(safeErrorFromUnknown(outer, fallback).diagnosticDetails).toEqual([commandDiagnostic]);
  });

  it("terminates cyclic cause traversal safely", () => {
    const first: { cause?: unknown } = {};
    const second: { cause?: unknown } = { cause: first };
    first.cause = second;

    expect(safeErrorFromUnknown(first, fallback)).toEqual(fallback);
  });

  it("rejects malformed diagnostic details without crashing normalization", () => {
    const malformed = {
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_COMMAND_FAILED",
      message: "Worktrunk failed.",
      diagnosticDetails: { type: "external_command" },
    };

    expect(safeErrorFromUnknown(malformed, fallback)).toEqual({
      tag: "WorktreeProviderError",
      code: "WORKTRUNK_COMMAND_FAILED",
      message: "Worktrunk failed.",
    });
  });

  it("projects only the lean public SafeError contract", () => {
    const cause = new Error("raw cause");
    const rich = Object.assign(new Error("External command failed."), {
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_FAILED",
      command: "wt switch feature",
      cwd: "/tmp/project",
      exitCode: 1,
      stdoutSnippet: "raw stdout",
      stderrSnippet: "raw stderr",
      diagnosticDetails: [commandDiagnostic],
      cause,
    });

    const projected = publicSafeErrorFromUnknown(rich, fallback);

    expect(projected).toEqual({
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_FAILED",
      message: "External command failed.",
    });
    expect(Object.keys(projected).sort()).toEqual(["code", "message", "tag"]);
  });

  it("preserves absence for optional public fields", () => {
    const normalized: RuntimeSafeError = safeErrorFromUnknown(
      {
        tag: "ProviderError",
        code: "PROVIDER_FAILED",
        message: "Provider failed.",
      },
      fallback,
    );

    expect(Object.keys(normalized).sort()).toEqual(["code", "message", "tag"]);
  });

  it("omits undefined optional fields from public projections", () => {
    const projected = publicSafeErrorFromUnknown(
      {
        tag: "ProviderError",
        code: "PROVIDER_FAILED",
        message: "Provider failed.",
        hint: undefined,
        projectId: undefined,
      },
      fallback,
    );

    expect(Object.keys(projected).sort()).toEqual(["code", "message", "tag"]);
    expect(Object.hasOwn(projected, "hint")).toBe(false);
    expect(Object.hasOwn(projected, "projectId")).toBe(false);
  });

  it("omits undefined optional fields from normalized diagnostic details", () => {
    const normalized = safeErrorFromUnknown(
      {
        tag: "ProviderError",
        code: "PROVIDER_FAILED",
        message: "Provider failed.",
        diagnosticDetails: [
          {
            type: "external_command",
            operation: "provider.test",
            command: "test",
            provider: undefined,
            cwd: undefined,
            exitCode: undefined,
            signal: undefined,
            stdoutSnippet: undefined,
            stderrSnippet: undefined,
            durationMs: undefined,
          },
          {
            type: "worktree_removal_refusal",
            worktreeId: "wt_1",
            canonicalPath: "/tmp/worktree",
            observedBranch: "main",
            refusalReason: "branch_changed",
            provider: undefined,
            projectId: undefined,
          },
        ],
      },
      fallback,
    );

    const [command, removal] = normalized.diagnosticDetails ?? [];
    expect(Object.keys(command ?? {}).sort()).toEqual(["command", "operation", "type"]);
    expect(Object.hasOwn(command ?? {}, "provider")).toBe(false);
    expect(Object.hasOwn(command ?? {}, "cwd")).toBe(false);
    expect(Object.keys(removal ?? {}).sort()).toEqual([
      "canonicalPath",
      "observedBranch",
      "refusalReason",
      "type",
      "worktreeId",
    ]);
    expect(Object.hasOwn(removal ?? {}, "provider")).toBe(false);
    expect(Object.hasOwn(removal ?? {}, "projectId")).toBe(false);
    expect(Object.keys(externalCommandDiagnosticFromSafeError(normalized) ?? {}).sort()).toEqual([
      "command",
      "operation",
      "type",
    ]);
  });

  it("omits undefined optional fields from synthesized command diagnostics", () => {
    const normalized = safeErrorFromUnknown(
      {
        tag: "ExternalCommandError",
        code: "EXTERNAL_COMMAND_FAILED",
        message: "External command failed.",
        command: "test",
        cwd: undefined,
        exitCode: undefined,
        signal: undefined,
        stdoutSnippet: undefined,
        stderrSnippet: undefined,
      },
      fallback,
    );
    const diagnostic = externalCommandDiagnosticFromSafeError(normalized);

    expect(Object.keys(normalized).sort()).toEqual([
      "code",
      "command",
      "diagnosticDetails",
      "message",
      "tag",
    ]);
    expect(Object.keys(diagnostic ?? {}).sort()).toEqual(["command", "operation", "type"]);
    expect(Object.hasOwn(diagnostic ?? {}, "cwd")).toBe(false);
    expect(Object.hasOwn(diagnostic ?? {}, "exitCode")).toBe(false);
  });
});
