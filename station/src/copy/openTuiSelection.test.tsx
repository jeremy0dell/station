import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import type { ClipboardEffects } from "./clipboard.js";
import { wireOpenTuiSelectionCopy } from "./openTuiSelection.js";

type ClipboardSelection = { getSelectedText(): string };

class FakeSelectionEmitter {
  listener: ((selection: ClipboardSelection) => void) | undefined;

  on(_event: "selection", listener: (selection: ClipboardSelection) => void): void {
    this.listener = listener;
  }

  finish(text: string): void {
    this.listener?.({ getSelectedText: () => text });
  }
}

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

describe("wireOpenTuiSelectionCopy", () => {
  it("copies a completed OpenTUI drag through every clipboard sink", async () => {
    const { effects, calls } = recordingEffects();
    const setup = await testRender(<text selectable>actionable error details</text>, {
      width: 32,
      height: 1,
    });
    try {
      wireOpenTuiSelectionCopy(setup.renderer, effects);
      await setup.renderOnce();
      await setup.mockMouse.drag(0, 0, "actionable".length, 0);

      expect(calls).toEqual([
        "internal:actionable",
        "osc52:actionable",
        "platform:actionable",
      ]);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("does not touch the clipboard for an empty selection", () => {
    const emitter = new FakeSelectionEmitter();
    const { effects, calls } = recordingEffects();

    wireOpenTuiSelectionCopy(emitter, effects);
    emitter.finish("");

    expect(calls).toEqual([]);
  });
});
