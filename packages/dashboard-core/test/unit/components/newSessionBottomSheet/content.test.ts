import {
  createNewSessionFlow,
  newSessionReviewContent,
  transitionNewSessionFlow,
} from "@station/dashboard-core";
import { describe, expect, it } from "vitest";
import { createDashboardSnapshot } from "../../../fixtures/snapshots.js";

function reviewState(status: "healthy" | "degraded" | "unavailable" = "healthy") {
  const snapshot = createDashboardSnapshot();
  const withHarness = {
    ...snapshot,
    harnesses: [{ id: "codex", label: "Codex" }],
    providerHealth: {
      ...snapshot.providerHealth,
      codex: {
        providerId: "codex",
        providerType: "harness" as const,
        status,
        lastCheckedAt: snapshot.generatedAt,
      },
    },
  };
  const state = createNewSessionFlow(withHarness, "aaaaaa");
  if (state === undefined) throw new Error("expected new-session flow");
  return { snapshot: withHarness, state };
}

describe("new-session review content", () => {
  it("attaches accelerators and separates agent identity from health", () => {
    const { snapshot, state } = reviewState();

    expect(newSessionReviewContent(snapshot, state)).toEqual({
      fields: [
        { id: "project", label: "Project (P)", value: "web" },
        { id: "name", label: "Name (N)", value: "web-aaaaaa" },
        {
          id: "agent",
          label: "Agent (A)",
          value: "Codex",
          status: { glyph: "●", text: "healthy", tone: "healthy" },
        },
      ],
      create: { label: "Create session", shortcut: "C", disabled: false },
      helper: "Enter create session",
    });
  });

  it("keeps degraded and unavailable status readable without color", () => {
    const degraded = reviewState("degraded");
    expect(newSessionReviewContent(degraded.snapshot, degraded.state).fields[2]).toMatchObject({
      value: "Codex",
      status: { glyph: "●", text: "degraded", tone: "degraded" },
    });

    const unavailable = reviewState("unavailable");
    const content = newSessionReviewContent(unavailable.snapshot, unavailable.state);
    expect(content.fields[2]).toMatchObject({
      value: "Codex",
      status: { glyph: "●", text: "unavailable", tone: "unavailable" },
    });
    expect(content.create.disabled).toBe(true);
  });

  it("describes the currently focused action", () => {
    const { snapshot, state } = reviewState();
    const expected = [
      ["project", "Enter choose project"],
      ["name", "Enter edit name"],
      ["agent", "Enter choose agent"],
      ["create", "Enter create session"],
    ] as const;

    let focused = state;
    for (const [focus, helper] of expected) {
      focused = { ...focused, reviewFocus: focus };
      expect(newSessionReviewContent(snapshot, focused).helper).toBe(helper);
    }

    const returned = transitionNewSessionFlow(state, { type: "editName" });
    if (returned?.mode !== "editName") throw new Error("expected edit-name flow");
    expect(returned.editNameFocus).toBe("name");
  });
});
