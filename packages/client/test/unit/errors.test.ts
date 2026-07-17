import {
  isObserverConnectError,
  isPermanentObserverError,
  safeErrorToNotice,
  toSafeError,
} from "@station/client";
import type { SafeError } from "@station/contracts";
import { describe, expect, it } from "vitest";

function protocolError(code: string): SafeError {
  return {
    tag: "ProtocolError",
    code,
    message: "Protocol failure for classification.",
  };
}

describe("client SafeError mapping", () => {
  it("preserves user-safe diagnostics from protocol errors", () => {
    const safe = toSafeError({
      tag: "TerminalProviderError",
      code: "TERMINAL_TARGET_MISSING",
      message: "The terminal target for this worktree no longer exists.",
      hint: "Refresh the dashboard or reopen the worktree.",
      diagnosticId: "diag_terminal_missing",
      traceId: "trc_terminal_missing",
    });

    expect(safeErrorToNotice(safe)).toEqual({
      kind: "error",
      message: "The terminal target for this worktree no longer exists.",
      hint: "Refresh the dashboard or reopen the worktree.",
      diagnosticId: "diag_terminal_missing",
      traceId: "trc_terminal_missing",
    });
  });

  it("converts unknown failures without leaking stacks or raw provider payloads", () => {
    const error = new Error("secret stack with providerData token");
    error.stack = "raw stack\nproviderData: token";

    const safe = toSafeError(error);
    const notice = safeErrorToNotice(safe);

    expect(notice.message).toBe("The client could not complete the observer operation.");
    expect(JSON.stringify(notice)).not.toContain("providerData");
    expect(JSON.stringify(notice)).not.toContain("raw stack");
    expect(JSON.stringify(notice)).not.toContain("token");
  });

  it("recognizes wrapped observer connect errors and hides raw socket paths in notices", () => {
    const cause = {
      tag: "ProtocolError",
      code: "PROTOCOL_CONNECT_FAILED",
      message: "Could not connect to observer socket /tmp/station-test.sock.",
    };
    const error = new Error("wrapped");
    (error as Error & { cause?: unknown }).cause = cause;

    const safe = toSafeError(error);
    const notice = safeErrorToNotice(safe);

    expect(isObserverConnectError(safe)).toBe(true);
    expect(notice).toEqual({
      kind: "error",
      message: "Observer is reconnecting.",
      hint: "Try the command again when the observer is ready.",
    });
    expect(JSON.stringify(notice)).not.toContain("/tmp/station-test.sock");
  });

  it("labels unknown failures when a client label is provided", () => {
    const safe = toSafeError(new Error("raw failure"), { clientLabel: "Station" });

    expect(safe).toMatchObject({
      code: "CLIENT_OBSERVER_OPERATION_FAILED",
      message: "The Station could not complete the observer operation.",
    });
  });
});

describe("retryable-versus-permanent observer error classification", () => {
  it("classifies build, schema, and validation incoherence as permanent", () => {
    const permanentCodes = [
      "OBSERVER_BUILD_MISMATCH",
      "PROTOCOL_SCHEMA_MISMATCH",
      "PROTOCOL_RESPONSE_VALIDATION_FAILED",
      "PROTOCOL_EVENT_VALIDATION_FAILED",
      "PROTOCOL_SUBSCRIBE_ACK_MISMATCH",
    ];
    for (const code of permanentCodes) {
      expect(isPermanentObserverError(protocolError(code)), code).toBe(true);
    }
  });

  it("classifies transient transport failures as retryable", () => {
    const retryableCodes = [
      "PROTOCOL_CONNECT_FAILED",
      "PROTOCOL_CONNECT_TIMEOUT",
      "PROTOCOL_REQUEST_FAILED",
      "PROTOCOL_REQUEST_TIMEOUT",
      "PROTOCOL_SOCKET_CLOSED",
      "PROTOCOL_SUBSCRIBE_TIMEOUT",
      "CLIENT_SNAPSHOT_TIMEOUT",
    ];
    for (const code of retryableCodes) {
      expect(isPermanentObserverError(protocolError(code)), code).toBe(false);
    }
  });

  it("defaults unknown codes to retryable so transient failures self-heal", () => {
    expect(isPermanentObserverError(protocolError("TOTALLY_NEW_CODE"))).toBe(false);
  });
});
