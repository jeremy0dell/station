import { afterEach, describe, expect, it } from "bun:test";
import { type BaseRenderable, rgbToHex, TextRenderable } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  createNewSessionFlow,
  transitionNewSessionFlow,
  type NewSessionFlowState,
} from "@station/dashboard-core";
import type { StationSnapshot } from "@station/contracts";
import { spanAtFrameCell } from "../../../terminal/testing/frameProbe.js";
import { manyProjectsSnapshot } from "../../fixtures/scenarios.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import { STATION_COLORS } from "../theme.js";
import { NewSessionSheetView } from "./NewSessionSheetView.js";

const teardowns: Array<() => void> = [];
afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
});

function snapshotWithCodexStatus(
  status: "healthy" | "degraded" | "unavailable" = "healthy",
): StationSnapshot {
  const snapshot = manyProjectsSnapshot();
  return {
    ...snapshot,
    providerHealth: {
      ...snapshot.providerHealth,
      codex: {
        providerId: "codex",
        providerType: "harness",
        status,
        lastCheckedAt: snapshot.generatedAt,
      },
    },
  };
}

async function render(
  snapshot: StationSnapshot,
  state: NewSessionFlowState,
  width = 80,
) {
  const targets: StationMouseTarget[] = [];
  const setup = await testRender(
    <StationHoverProvider value>
      <StationMouseProvider value={(target) => targets.push(target)}>
        <NewSessionSheetView
          snapshot={snapshot}
          state={state}
          selection={new Map()}
          columns={width}
          rows={24}
        />
      </StationMouseProvider>
    </StationHoverProvider>,
    { width, height: 24 },
  );
  teardowns.push(() => setup.renderer.destroy());
  await setup.renderOnce();
  return { setup, targets };
}

describe("NewSessionSheetView", () => {
  it("renders separate agent health and exact review mouse targets", async () => {
    const snapshot = snapshotWithCodexStatus();
    const state = createNewSessionFlow(snapshot, "aaaaaa");
    if (state === undefined) throw new Error("expected new-session flow");
    const { setup, targets } = await render(snapshot, state);
    const lines = setup.captureCharFrame().split("\n");
    const projectRow = lines.findIndex((line) => line.includes("Project (P)"));
    const shortcutCol = lines[projectRow]?.indexOf("P)") ?? -1;
    const shortcutSpan = spanAtFrameCell(setup.captureSpans(), projectRow, shortcutCol);
    expect(shortcutSpan?.fg === undefined ? undefined : rgbToHex(shortcutSpan.fg)).toBe(
      STATION_COLORS.yellow,
    );

    const agentRow = lines.findIndex((line) => line.includes("Agent (A)"));
    const healthCol = lines[agentRow]?.indexOf("healthy") ?? -1;
    expect(lines[agentRow]).toContain("codex ● healthy");
    const healthSpan = spanAtFrameCell(setup.captureSpans(), agentRow, healthCol);
    expect(healthSpan?.fg === undefined ? undefined : rgbToHex(healthSpan.fg)).toBe(
      STATION_COLORS.green,
    );

    const createRow = lines.findIndex((line) => line.includes("Create session (C)"));
    const createCol = lines[createRow]?.indexOf("Create session") ?? -1;
    await setup.mockMouse.click(createCol, createRow, MouseButtons.LEFT);
    expect(targets.at(-1)).toEqual({ kind: "newSessionAction", actionId: "review.create" });
  });

  it("hides the input cursor while Save or Back owns focus", async () => {
    const snapshot = snapshotWithCodexStatus();
    const review = createNewSessionFlow(snapshot, "aaaaaa");
    if (review === undefined) throw new Error("expected new-session flow");
    const edit = transitionNewSessionFlow(review, { type: "editName" });
    if (edit?.mode !== "editName") throw new Error("expected edit-name flow");
    const save = transitionNewSessionFlow(edit, { type: "editNameFocus", dir: 1 });
    if (save?.mode !== "editName") throw new Error("expected edit-name flow");

    const { setup } = await render(snapshot, save);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("▸ Save (Ctrl-S)");
    expect(frame).not.toContain("|station-aaaaaa");
    expect(frame).toMatch(/Name\s+station-aaaaaa/);
  });

  it("keeps fields, status, and the primary action readable when narrow", async () => {
    const snapshot = snapshotWithCodexStatus("degraded");
    const state = createNewSessionFlow(snapshot, "aaaaaa");
    if (state === undefined) throw new Error("expected new-session flow");
    const { setup } = await render(snapshot, state, 40);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Project (P)");
    expect(frame).toContain("Name (N)");
    expect(frame).toContain("Agent (A)");
    expect(frame).toContain("● degraded");
    expect(frame).toContain("Create session (C)");
  });

  it("prevents terminal text selection across the sheet", async () => {
    const snapshot = snapshotWithCodexStatus();
    const state = createNewSessionFlow(snapshot, "aaaaaa");
    if (state === undefined) throw new Error("expected new-session flow");
    const { setup } = await render(snapshot, state);
    const lines = setup.captureCharFrame().split("\n");
    const titleRow = lines.findIndex((line) => line.includes("Create Session"));
    const agentRow = lines.findIndex((line) => line.includes("Agent (A)"));

    await act(async () => {
      await setup.mockMouse.drag(3, titleRow, 30, agentRow, MouseButtons.LEFT);
    });

    expect(setup.renderer.hasSelection).toBe(false);
    const textRenderables = collectTextRenderables(setup.renderer.root);
    expect(textRenderables.length).toBeGreaterThan(0);
    expect(textRenderables.every((renderable) => renderable.selectable === false)).toBe(true);
  });

  it("renders unavailable Create as disabled", async () => {
    const snapshot = snapshotWithCodexStatus("unavailable");
    const state = createNewSessionFlow(snapshot, "aaaaaa");
    if (state === undefined) throw new Error("expected new-session flow");
    const { setup, targets } = await render(snapshot, state);
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Create session (C)"));
    const col = lines[row]?.indexOf("Create session") ?? -1;
    await setup.mockMouse.click(col, row, MouseButtons.LEFT);
    expect(
      targets.some(
        (target) =>
          target.kind === "newSessionAction" && target.actionId === "review.create",
      ),
    ).toBe(false);
  });
});

function collectTextRenderables(renderable: BaseRenderable): TextRenderable[] {
  const collected = renderable instanceof TextRenderable ? [renderable] : [];
  for (const child of renderable.getChildren()) {
    collected.push(...collectTextRenderables(child));
  }
  return collected;
}
