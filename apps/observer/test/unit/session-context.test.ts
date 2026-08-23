import { createFakeTerminalTarget, FakeTerminalProvider } from "@station/testing";
import { describe, expect, it } from "vitest";
import type { ProviderRegistry } from "../../src/providers/registry.js";
import type { ObserverCore } from "../../src/reconcile/core.js";
import { resolveCurrentSessionContext } from "../../src/runtime/sessionContext.js";

const source = {
  provider: "fake-terminal",
  targetId: "term_source",
  generation: "generation_a",
  authorityId: "authority_a",
  expiresAt: "2026-08-20T12:10:00.000Z",
} as const;

const caller = {
  process: { pid: 42, startToken: "Tue Aug 20 12:00:00 2026" },
  claims: {},
} as const;

describe("resolveCurrentSessionContext", () => {
  it("returns only the public authority and exact correlated Session Group", async () => {
    const terminal = new FakeTerminalProvider({
      currentPlacement: source,
      targets: [
        createFakeTerminalTarget({
          id: source.targetId,
          provider: source.provider,
          projectId: "web",
          worktreeId: "wt_web_feature",
          sessionId: "ses_web_feature",
        }),
      ],
    });
    const providers = {
      terminals: new Map([[terminal.id, terminal]]),
      terminalPlacements: new Map([[terminal.id, terminal.placement]]),
    } as unknown as ProviderRegistry;
    const core = {
      getSnapshot: () => ({
        sessions: [{ id: "ses_web_feature", projectId: "web", worktreeId: "wt_web_feature" }],
        sessionGroups: [
          {
            id: "grp_release",
            projectId: "web",
            name: "Release",
            sessionIds: ["ses_web_feature"],
          },
        ],
      }),
    } as unknown as ObserverCore;

    await expect(resolveCurrentSessionContext({ providers, core, caller })).resolves.toEqual({
      source,
      presentation: "presented",
      session: {
        id: "ses_web_feature",
        projectId: "web",
        worktreeId: "wt_web_feature",
        group: { id: "grp_release", name: "Release" },
      },
    });
  });

  it("rejects absent and ambiguous terminal claims", async () => {
    const missingProviders = {
      terminals: new Map([["fake-terminal", new FakeTerminalProvider()]]),
      terminalPlacements: new Map(),
    } as unknown as ProviderRegistry;
    const core = {
      getSnapshot: () => ({ sessions: [], sessionGroups: [] }),
    } as unknown as ObserverCore;

    await expect(
      resolveCurrentSessionContext({ providers: missingProviders, core, caller }),
    ).rejects.toMatchObject({
      code: "TERMINAL_CALLER_CONTEXT_MISSING",
    });

    const other = new FakeTerminalProvider({
      id: "other-terminal",
      currentPlacement: { ...source, provider: "other-terminal", authorityId: "authority_b" },
    });
    const ambiguousProviders = {
      terminals: new Map([
        ["fake-terminal", new FakeTerminalProvider({ currentPlacement: source })],
        [other.id, other],
      ]),
      terminalPlacements: new Map([
        ["fake-terminal", new FakeTerminalProvider({ currentPlacement: source }).placement],
        [other.id, other.placement],
      ]),
    } as unknown as ProviderRegistry;
    await expect(
      resolveCurrentSessionContext({ providers: ambiguousProviders, core, caller }),
    ).rejects.toMatchObject({
      code: "TERMINAL_CALLER_CONTEXT_AMBIGUOUS",
    });
  });
});
