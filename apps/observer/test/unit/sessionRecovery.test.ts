import type { HarnessProvider, SessionRecoveryHandle } from "@station/contracts";
import {
  createFakeWorktree,
  FakeHarnessProvider,
  FakeTerminalProvider,
  FakeWorktreeProvider,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../src/providers/registry";
import { resolveSessionRecovery } from "../../src/sessionRecovery";
import { createInMemoryObserverPersistence } from "../support/inMemoryObserverPersistence";

const now = "2026-08-08T12:00:00.000Z";
const worktree = createFakeWorktree({
  id: "wt_web_feature",
  projectId: "web",
  branch: "feature",
  path: "/tmp/station/web/feature",
  now,
});

function recoveryHandle(overrides: Partial<SessionRecoveryHandle> = {}): SessionRecoveryHandle {
  return {
    id: "rec_feature",
    provider: "fake-harness",
    projectId: "web",
    worktreeId: worktree.id,
    sessionId: "ses_feature",
    target: { kind: "native-session", id: "native_feature" },
    cwd: worktree.path,
    observedAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

function providerRegistry(harnesses: HarnessProvider[]): ProviderRegistry {
  return new ProviderRegistry({
    worktree: new FakeWorktreeProvider({ worktrees: [worktree], now }),
    terminal: new FakeTerminalProvider({ now }),
    harnesses,
  });
}

async function resolveRecovery(
  options: {
    handles?: SessionRecoveryHandle[];
    harnesses?: HarnessProvider[];
    recoveryHandleId?: string;
    expected?: { sessionId: string; provider: string };
  } = {},
) {
  const persistence = createInMemoryObserverPersistence({
    clock: { now: () => new Date(now) },
  });
  const persistedIds = new Map<string, string>();
  for (const handle of options.handles ?? []) {
    const persisted = await persistence.upsertSessionRecoveryHandle(handle);
    persistedIds.set(handle.id, persisted.id);
  }
  const input: Parameters<typeof resolveSessionRecovery>[0] = {
    persistence,
    providers: providerRegistry(
      options.harnesses ?? [new FakeHarnessProvider({ id: "fake-harness", now })],
    ),
    projectId: "web",
    worktreeId: worktree.id,
    worktree,
  };
  if (options.recoveryHandleId !== undefined) {
    input.recoveryHandleId = persistedIds.get(options.recoveryHandleId) ?? options.recoveryHandleId;
  }
  if (options.expected !== undefined) {
    input.expected = options.expected;
  }
  return resolveSessionRecovery(input);
}

describe("resolveSessionRecovery", () => {
  it("resolves an explicitly selected handle from multiple choices", async () => {
    const selected = recoveryHandle();
    const other = recoveryHandle({
      id: "rec_other",
      target: { kind: "native-session", id: "native_other" },
    });
    const harness = new FakeHarnessProvider({ id: "fake-harness", now });

    const result = await resolveRecovery({
      handles: [selected, other],
      harnesses: [harness],
      recoveryHandleId: selected.id,
    });

    expect(result.handle).toMatchObject({
      provider: selected.provider,
      target: selected.target,
      sessionId: selected.sessionId,
    });
    expect(result.harness).toBe(harness);
    expect(result.resume).toEqual({
      target: selected.target,
      previousSessionId: "ses_feature",
      recoveryHandleId: result.handle.id,
    });
  });

  it("omits previousSessionId when the selected handle has no Station identity", async () => {
    const handle = recoveryHandle();
    delete handle.sessionId;

    const result = await resolveRecovery({
      handles: [handle],
      recoveryHandleId: handle.id,
    });

    expect(result.resume).toEqual({
      target: handle.target,
      recoveryHandleId: result.handle.id,
    });
  });

  it("rejects missing and cross-worktree selected handles", async () => {
    await expect(resolveRecovery({ recoveryHandleId: "rec_missing" })).rejects.toMatchObject({
      code: "SESSION_RECOVERY_HANDLE_NOT_FOUND",
    });

    const otherProject = recoveryHandle({ projectId: "other" });
    await expect(
      resolveRecovery({ handles: [otherProject], recoveryHandleId: otherProject.id }),
    ).rejects.toMatchObject({ code: "SESSION_RECOVERY_HANDLE_MISMATCH" });

    const otherWorktree = recoveryHandle({ worktreeId: "wt_web_other" });
    await expect(
      resolveRecovery({ handles: [otherWorktree], recoveryHandleId: otherWorktree.id }),
    ).rejects.toMatchObject({ code: "SESSION_RECOVERY_HANDLE_MISMATCH" });
  });

  it("rejects unregistered and resume-disabled selected providers", async () => {
    const missingProvider = recoveryHandle({ provider: "missing-harness" });
    await expect(
      resolveRecovery({
        handles: [missingProvider],
        harnesses: [],
        recoveryHandleId: missingProvider.id,
      }),
    ).rejects.toMatchObject({
      code: "HARNESS_PROVIDER_UNAVAILABLE",
      provider: "missing-harness",
    });

    const disabledProvider = new FakeHarnessProvider({
      id: "fake-harness",
      now,
      capabilities: { canResume: false },
    });
    const handle = recoveryHandle();
    await expect(
      resolveRecovery({
        handles: [handle],
        harnesses: [disabledProvider],
        recoveryHandleId: handle.id,
      }),
    ).rejects.toMatchObject({
      code: "HARNESS_RESUME_UNSUPPORTED",
      provider: disabledProvider.id,
    });
  });

  it("selects the only actionable automatic handle", async () => {
    const selected = recoveryHandle();
    const disabled = recoveryHandle({
      id: "rec_disabled",
      provider: "disabled-harness",
      target: { kind: "native-session", id: "native_disabled" },
    });
    const unregistered = recoveryHandle({
      id: "rec_unregistered",
      provider: "unregistered-harness",
      target: { kind: "native-session", id: "native_unregistered" },
    });

    const result = await resolveRecovery({
      handles: [selected, disabled, unregistered],
      harnesses: [
        new FakeHarnessProvider({ id: "fake-harness", now }),
        new FakeHarnessProvider({
          id: "disabled-harness",
          now,
          capabilities: { canResume: false },
        }),
      ],
    });

    expect(result.handle).toMatchObject({
      provider: selected.provider,
      target: selected.target,
      sessionId: selected.sessionId,
    });
  });

  it("requires exactly one actionable automatic handle", async () => {
    await expect(resolveRecovery()).rejects.toMatchObject({
      code: "SESSION_RECOVERY_HANDLE_NOT_FOUND",
    });

    const first = recoveryHandle();
    const second = recoveryHandle({
      id: "rec_second",
      target: { kind: "native-session", id: "native_second" },
    });
    await expect(resolveRecovery({ handles: [first, second] })).rejects.toMatchObject({
      code: "SESSION_RECOVERY_HANDLE_AMBIGUOUS",
    });
  });

  it("requires the canonical session and provider when expectations are supplied", async () => {
    const expected = { sessionId: "ses_feature", provider: "fake-harness" };
    await expect(resolveRecovery({ handles: [recoveryHandle()], expected })).resolves.toMatchObject(
      {
        resume: { previousSessionId: expected.sessionId },
      },
    );

    const missingSession = recoveryHandle();
    delete missingSession.sessionId;
    await expect(resolveRecovery({ handles: [missingSession], expected })).rejects.toMatchObject({
      code: "SESSION_RECOVERY_HANDLE_MISMATCH",
    });
    await expect(
      resolveRecovery({ handles: [recoveryHandle({ sessionId: "ses_other" })], expected }),
    ).rejects.toMatchObject({ code: "SESSION_RECOVERY_HANDLE_MISMATCH" });
    await expect(
      resolveRecovery({
        handles: [recoveryHandle({ provider: "other-harness" })],
        harnesses: [new FakeHarnessProvider({ id: "other-harness", now })],
        expected,
      }),
    ).rejects.toMatchObject({ code: "SESSION_RECOVERY_HANDLE_MISMATCH" });
  });

  it("accepts absent or nested cwd and rejects recovery outside the worktree", async () => {
    const withoutCwd = recoveryHandle();
    delete withoutCwd.cwd;
    const withoutCwdResult = await resolveRecovery({ handles: [withoutCwd] });
    expect(withoutCwdResult.handle).not.toHaveProperty("cwd");
    await expect(
      resolveRecovery({ handles: [recoveryHandle({ cwd: `${worktree.path}/nested` })] }),
    ).resolves.toMatchObject({ handle: { cwd: `${worktree.path}/nested` } });
    await expect(
      resolveRecovery({ handles: [recoveryHandle({ cwd: "/tmp/station/other" })] }),
    ).rejects.toMatchObject({ code: "SESSION_RECOVERY_CWD_MISMATCH" });
  });
});
