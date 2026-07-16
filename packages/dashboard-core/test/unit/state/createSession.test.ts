import type { SafeError } from "@station/contracts";
import { createTuiStore } from "@station/dashboard-core";
import { describe, expect, it, vi } from "vitest";
import { runCreateSessionOperation } from "../../../src/state/operations/createSession.js";
import { createCommandSnapshot } from "../../fixtures/snapshots.js";
import { FakeTuiObserverService } from "../../support/fakeObserverService.js";

describe("create session operation", () => {
  it("dismisses the exact focus target after successful creation", async () => {
    const fixture = createFixture();
    const dismiss = vi.fn(async () => {});

    await fixture.run({ onFocusSuccess: dismiss });

    expect(dismiss).toHaveBeenCalledOnce();
    expect(fixture.service.dispatched).toEqual([
      {
        ...operation.command,
        payload: {
          ...operation.command.payload,
          terminal: {
            ...operation.command.payload.terminal,
            focus: true,
            origin: { provider: "fixture-terminal", clientId: "client-current" },
          },
        },
      },
    ]);
    expect(fixture.failures).toEqual([]);
    expect(fixture.toasts).toEqual([]);
  });

  it("keeps the focus target open when creation fails", async () => {
    const fixture = createFixture();
    const failure = safeError("CREATE_FAILED", "Session creation failed.");
    fixture.service.nextCompletion = {
      status: "failed",
      commandId: "cmd_tui_1",
      error: failure,
    };
    const dismiss = vi.fn(async () => {});

    await fixture.run({ onFocusSuccess: dismiss });

    expect(dismiss).not.toHaveBeenCalled();
    expect(fixture.failures).toEqual([failure]);
    expect(fixture.toasts).toEqual([failure]);
  });

  it("toasts a stale exact-target dismissal without failing successful creation", async () => {
    const fixture = createFixture();
    const stale = safeError(
      "TUI_POPUP_FOCUS_TARGET_STALE",
      "The popup focus target changed before dismissal.",
    );

    await fixture.run({
      onFocusSuccess: async () => {
        throw stale;
      },
    });

    expect(fixture.failures).toEqual([]);
    expect(fixture.toasts).toEqual([stale]);
  });
});

const operation = {
  type: "createSession" as const,
  localId: "local_create_1",
  projectId: "web",
  branch: "feature/new-session",
  harnessProvider: "codex",
  command: {
    type: "session.create" as const,
    payload: {
      projectId: "web",
      branch: "feature/new-session",
      harness: { provider: "codex", mode: "interactive" as const },
      terminal: { provider: "fixture-terminal", layout: "agent-build-shell", focus: false },
    },
  },
};

function createFixture() {
  const snapshot = createCommandSnapshot("idle");
  const service = new FakeTuiObserverService(snapshot);
  const store = createTuiStore({ service, initialSnapshot: snapshot });
  const failures: SafeError[] = [];
  const toasts: SafeError[] = [];

  return {
    service,
    failures,
    toasts,
    run: (target: { onFocusSuccess: () => Promise<void> }) =>
      runCreateSessionOperation(
        store,
        service,
        {
          clientLabel: "station",
          persistentPopup: true,
          resolveFocusTarget: async () => ({
            origin: { provider: "fixture-terminal", clientId: "client-current" },
            onFocusSuccess: target.onFocusSuccess,
          }),
        },
        operation,
        (_localId, error) => failures.push(error),
        () => {},
        () => false,
        (error) => toasts.push(error),
      ),
  };
}

function safeError(code: string, message: string): SafeError {
  return { tag: "CreateSessionTestError", code, message };
}
