import { afterEach, describe, expect, it } from "bun:test";
import { type BaseRenderable, rgbToHex, TextRenderable } from "@opentui/core";
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import {
  createNewSessionFlow,
  NEW_SESSION_CREATE_GROUP_CHOICE_ID,
  transitionNewSessionFlow,
} from "@station/dashboard-core/state";
import type { StationSnapshot } from "@station/contracts";
import { spanAtFrameCell } from "../../../terminal/testing/frameProbe.js";
import { groupedManyProjectsSnapshot, manyProjectsSnapshot } from "../../fixtures/scenarios.js";
import type { StationMouseTarget } from "../../input/stationMouse.js";
import { semanticItemRenderableId } from "../layout/scroll/scrollViewport.js";
import { StationHoverProvider, StationMouseProvider } from "../stationMouseContext.js";
import {
  nativeStationTheme,
  stationColorSnapshotValue,
  StationThemeProvider,
} from "../../../theme/index.js";
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
        provider: "codex",
        providerType: "harness",
        status,
        lastCheckedAt: snapshot.generatedAt,
      },
    },
  };
}

/** Flow state named through the public transition contract rather than the private mutable model. */
type NewSessionSheetFlowState = NonNullable<Parameters<typeof transitionNewSessionFlow>[0]>;

async function render(snapshot: StationSnapshot, state: NewSessionSheetFlowState, width = 80) {
  const targets: StationMouseTarget[] = [];
  const setup = await testRender(
    <StationThemeProvider theme={nativeStationTheme}>
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
      </StationHoverProvider>
    </StationThemeProvider>,
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
      stationColorSnapshotValue(nativeStationTheme.status.warning),
    );

    const agentRow = lines.findIndex((line) => line.includes("Agent (A)"));
    const healthCol = lines[agentRow]?.indexOf("healthy") ?? -1;
    expect(lines[agentRow]).toContain("codex ● healthy");
    const healthSpan = spanAtFrameCell(setup.captureSpans(), agentRow, healthCol);
    expect(healthSpan?.fg === undefined ? undefined : rgbToHex(healthSpan.fg)).toBe(
      stationColorSnapshotValue(nativeStationTheme.status.success),
    );

    const createRow = lines.findIndex((line) => line.includes("Create session (C)"));
    const createCol = lines[createRow]?.indexOf("Create session") ?? -1;
    await setup.mockMouse.click(createCol, createRow, MouseButtons.LEFT);
    expect(targets.at(-1)).toEqual({ kind: "newSessionAction", actionId: "review.create" });

    const groupRow = lines.findIndex((line) => line.includes("Group (G)"));
    const groupCol = lines[groupRow]?.indexOf("Group") ?? -1;
    await setup.mockMouse.click(groupCol, groupRow, MouseButtons.LEFT);
    expect(targets.at(-1)).toEqual({ kind: "newSessionAction", actionId: "review.group" });
  });

  it("renders root Group choices and the inline editor in the same sheet", async () => {
    const snapshot = groupedManyProjectsSnapshot();
    const review = createNewSessionFlow(snapshot, "aaaaaa");
    if (review === undefined) throw new Error("expected new-session flow");
    const picker = transitionNewSessionFlow(review, { type: "pickGroup" });
    if (picker?.mode !== "pickGroup") throw new Error("expected Group picker");
    const picked = await render(snapshot, picker);
    const pickerFrame = picked.setup.captureCharFrame();
    expect(pickerFrame).toContain("U Ungrouped");
    expect(pickerFrame).toContain("1 Design refresh");
    expect(
      picked.setup.renderer.root.findDescendantById(
        semanticItemRenderableId(NEW_SESSION_CREATE_GROUP_CHOICE_ID),
      ),
    ).toBeDefined();

    const editor = transitionNewSessionFlow(picker, { type: "editGroupDraft" });
    if (editor?.mode !== "editGroupDraft") throw new Error("expected Group editor");
    const edited = await render(snapshot, editor);
    expect(edited.setup.captureCharFrame()).toContain("Type Group name · Enter save · Esc discard");
    expect(edited.setup.captureCharFrame()).toContain("Save (Enter)");
    expect(edited.setup.captureCharFrame()).toContain("Back (Esc)");

    const typed = transitionNewSessionFlow(editor, {
      type: "editGroupDraftInput",
      action: { type: "insert", input: "Release" },
    });
    if (typed?.mode !== "editGroupDraft") throw new Error("expected Group editor");
    const actionable = await render(snapshot, typed);
    const lines = actionable.setup.captureCharFrame().split("\n");
    const buttonRow = lines.findIndex((line) => line.includes("Save (Enter)"));
    await actionable.setup.mockMouse.click(
      lines[buttonRow]?.indexOf("Save") ?? -1,
      buttonRow,
      MouseButtons.LEFT,
    );
    expect(actionable.targets.at(-1)).toEqual({
      kind: "newSessionAction",
      actionId: "editGroupDraft.save",
    });
    await actionable.setup.mockMouse.click(
      lines[buttonRow]?.indexOf("Back") ?? -1,
      buttonRow,
      MouseButtons.LEFT,
    );
    expect(actionable.targets.at(-1)).toEqual({
      kind: "newSessionAction",
      actionId: "editGroupDraft.back",
    });
  });

  it("shows bounded progress and disables duplicate Create activation", async () => {
    const snapshot = snapshotWithCodexStatus();
    const review = createNewSessionFlow(snapshot, "aaaaaa");
    if (review === undefined) throw new Error("expected new-session flow");
    const { setup, targets } = await render(snapshot, {
      ...review,
      submissionLocalId: "create:station:test",
    });
    const lines = setup.captureCharFrame().split("\n");
    const createRow = lines.findIndex((line) => line.includes("Creating…"));
    expect(createRow).toBeGreaterThanOrEqual(0);
    expect(setup.captureCharFrame()).toContain("Creating session…");
    await setup.mockMouse.click(lines[createRow]?.indexOf("Creating") ?? -1, createRow, MouseButtons.LEFT);
    expect(
      targets.some(
        (target) =>
          target.kind === "newSessionAction" && target.actionId === "review.create",
      ),
    ).toBe(false);
  });

  it("hides the input cursor while Save or Back owns focus", async () => {
    const snapshot = snapshotWithCodexStatus();
    const review = createNewSessionFlow(snapshot, "aaaaaa");
    if (review === undefined) throw new Error("expected new-session flow");
    const edit = transitionNewSessionFlow(review, { type: "editName" });
    if (edit?.mode !== "editName") throw new Error("expected edit-name flow");
    const save = transitionNewSessionFlow(edit, {
      type: "editNameFocusSet",
      focus: "save",
    });
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
        (target) => target.kind === "newSessionAction" && target.actionId === "review.create",
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
