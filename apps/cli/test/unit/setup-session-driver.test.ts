import { describe, expect, it, vi } from "vitest";
import { createSetupComposition } from "../../src/commands/setup/composition.js";
import { runGuidedSetupSession } from "../../src/commands/setup/session/runGuidedSetupSession.js";
import type { SetupPromptAdapter } from "../../src/commands/setup/types.js";

function promptFixture(overrides: Partial<SetupPromptAdapter> = {}): SetupPromptAdapter {
  const noop = () => undefined;
  return {
    isInteractiveTerminal: () => true,
    intro: noop,
    outro: noop,
    cancel: noop,
    async confirm() {
      throw new Error("prompt must not run");
    },
    async selectOne() {
      throw new Error("prompt must not run");
    },
    async selectMany() {
      throw new Error("prompt must not run");
    },
    note: noop,
    logStep: noop,
    logSuccess: noop,
    logWarn: noop,
    logError: noop,
    logInfo: noop,
    ...overrides,
  };
}

describe("guided setup session driver", () => {
  it("checks terminal interactivity before setup inspection", async () => {
    const inspect = vi.fn();
    const chunks: string[] = [];
    const deps = {
      now: inspect,
      prompt: promptFixture({ isInteractiveTerminal: () => false }),
      writeStdout: (chunk: string) => {
        chunks.push(chunk);
      },
    };

    const result = await runGuidedSetupSession({}, deps, (...compositionArguments) => {
      const [options, operationProgress, initialIntent] = compositionArguments;
      return createSetupComposition({
        mode: "apply",
        options,
        deps,
        noBrew: false,
        planConfigWrite: true,
        initialIntent,
        operationProgress,
      });
    });

    expect(result.code).toBe(1);
    expect(inspect).not.toHaveBeenCalled();
    expect(chunks.join("")).toContain("Guided setup requires an interactive terminal.");
    expect(chunks.join("")).toContain("stn setup check --json");
  });

  it("closes the Clack guide normally when session inspection blocks", async () => {
    const outro = vi.fn();
    const chunks: string[] = [];
    const deps = {
      now: () => {
        throw new Error("synthetic inspection failure");
      },
      prompt: promptFixture({ outro }),
      writeStdout: (chunk: string) => {
        chunks.push(chunk);
      },
    };

    const result = await runGuidedSetupSession({}, deps, (...compositionArguments) => {
      const [options, operationProgress, initialIntent] = compositionArguments;
      return createSetupComposition({
        mode: "apply",
        options,
        deps,
        noBrew: false,
        planConfigWrite: true,
        initialIntent,
        operationProgress,
      });
    });

    expect(result.code).toBe(1);
    expect(outro).toHaveBeenCalledWith("Setup incomplete.");
    expect(chunks.join("")).toContain(
      "Setup facts could not be inspected. (SETUP_INSPECTION_FAILED)",
    );
  });
});
