import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ClipboardEffects } from "./clipboard.js";
import { createOpenTuiSelectionCopyHandler } from "./openTuiSelection.js";

function recordingEffects(): { effects: ClipboardEffects; calls: string[] } {
  const calls: string[] = [];
  return {
    effects: {
      setInternal: (text) => calls.push(`internal:${text}`),
      writeOsc52: (text) => calls.push(`osc52:${text}`),
      copyToPlatform: (text) => calls.push(`platform:${text}`),
      isRemoteSession: () => false,
    },
    calls,
  };
}

describe("createOpenTuiSelectionCopyHandler", () => {
  it("waits for Ctrl-C before copying an OpenTUI drag", async () => {
    const { effects, calls } = recordingEffects();
    const setup = await testRender(<text selectable>actionable error details</text>, {
      width: 32,
      height: 1,
    });
    try {
      const handleCopy = createOpenTuiSelectionCopyHandler(() => setup.renderer, effects);
      await setup.renderOnce();
      await setup.mockMouse.drag(0, 0, "actionable".length, 0);

      expect(calls).toEqual([]);
      expect(handleCopy("x")).toBe(false);
      expect(handleCopy("\x03")).toBe(true);
      expect(calls).toEqual([
        "internal:actionable",
        "osc52:actionable",
        "platform:actionable",
      ]);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("lets Ctrl-C fall through when there is no selection", () => {
    const { effects, calls } = recordingEffects();
    const handleCopy = createOpenTuiSelectionCopyHandler(
      () => ({ getSelection: () => null }),
      effects,
    );

    expect(handleCopy("\x03")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("accepts the Kitty Ctrl-C sequence used by Station", () => {
    const { effects, calls } = recordingEffects();
    const handleCopy = createOpenTuiSelectionCopyHandler(
      () => ({ getSelection: () => ({ getSelectedText: () => "trace trace_123" }) }),
      effects,
    );

    expect(handleCopy("\x1b[99;5u")).toBe(true);
    expect(calls).toEqual([
      "internal:trace trace_123",
      "osc52:trace trace_123",
      "platform:trace trace_123",
    ]);
  });
});
