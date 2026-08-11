import { describe, expect, it } from "vitest";
import {
  newSessionEditNameContent,
  newSessionReviewContent,
} from "../../../../src/components/NewSessionBottomSheet/content.js";
import {
  createNewSessionFlow,
  transitionNewSessionFlow,
} from "../../../../src/flows/newSession.js";
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
        {
          id: "project",
          actionId: "review.project",
          label: "Project",
          accelerator: "P",
          enabled: true,
          focusId: "project",
          helper: "Enter choose project",
          value: "web",
        },
        {
          id: "name",
          actionId: "review.name",
          label: "Name",
          accelerator: "N",
          enabled: true,
          focusId: "name",
          helper: "Enter edit name",
          value: "web-aaaaaa",
        },
        {
          id: "agent",
          actionId: "review.agent",
          label: "Agent",
          accelerator: "A",
          enabled: true,
          focusId: "agent",
          helper: "Enter choose agent",
          value: "Codex",
          status: { glyph: "●", text: "healthy", tone: "healthy" },
        },
        {
          id: "group",
          actionId: "review.group",
          label: "Group",
          accelerator: "G",
          enabled: true,
          focusId: "group",
          helper: "Enter choose Group",
          value: "Ungrouped",
        },
      ],
      create: {
        actionId: "review.create",
        label: "Create session",
        accelerator: "C",
        enabled: true,
        focusId: "create",
        helper: "Enter create session",
      },
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
    expect(content.create.enabled).toBe(false);
  });

  it("describes the currently focused action", () => {
    const { snapshot, state } = reviewState();
    const expected = [
      ["project", "Enter choose project"],
      ["name", "Enter edit name"],
      ["agent", "Enter choose agent"],
      ["group", "Enter choose Group"],
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

  it("carries semantic action and focus metadata for name-editor controls", () => {
    const { state } = reviewState();
    const editing = transitionNewSessionFlow(state, { type: "editName" });
    if (editing?.mode !== "editName") throw new Error("expected edit-name flow");

    expect(newSessionEditNameContent(editing)).toEqual({
      controls: {
        name: {
          actionId: "editName.name",
          label: "Name",
          accelerator: undefined,
          enabled: true,
          focusId: "name",
          helper: "Type name · Left/Right cursor · ↓ actions · Enter save",
        },
        save: {
          actionId: "editName.save",
          label: "Save",
          accelerator: "Ctrl-S",
          enabled: true,
          focusId: "save",
          helper: "←→ action · ↑ name · Enter save · Esc back",
        },
        back: {
          actionId: "editName.back",
          label: "Back",
          accelerator: "Esc",
          enabled: true,
          focusId: "back",
          helper: "←→ action · ↑ name · Enter back without saving",
        },
      },
      helper: "Type name · Left/Right cursor · ↓ actions · Enter save",
    });
  });
});
