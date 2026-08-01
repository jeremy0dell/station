import { describe, expect, it, vi } from "vitest";
import { createSetupComposition } from "../../src/commands/setup/composition.js";
import { runGuidedSetupSession } from "../../src/commands/setup/session/runGuidedSetupSession.js";

describe("guided setup session driver", () => {
  it("closes the line prompt in finally when the session inspection blocks", async () => {
    const close = vi.fn();
    const chunks: string[] = [];
    const deps = {
      now: () => {
        throw new Error("synthetic inspection failure");
      },
      prompt: {
        async confirm() {
          throw new Error("prompt must not run");
        },
        async selectMany() {
          throw new Error("prompt must not run");
        },
        close,
      },
      writeStdout: (chunk: string) => {
        chunks.push(chunk);
      },
    };

    const result = await runGuidedSetupSession(
      {},
      deps,
      (options, operationProgress, initialIntent) =>
        createSetupComposition({
          mode: "apply",
          options,
          deps,
          noBrew: false,
          planConfigWrite: true,
          initialIntent,
          operationProgress,
        }),
    );

    expect(result.code).toBe(1);
    expect(close).toHaveBeenCalledOnce();
    expect(chunks.join("")).toContain(
      "Setup facts could not be inspected. (SETUP_INSPECTION_FAILED)",
    );
  });
});
