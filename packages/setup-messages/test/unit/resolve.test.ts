import { describe, expect, it } from "vitest";
import { resolveSetupMessage, type SetupMessageRef, setupMessageRef } from "../../src/index.js";

describe("resolveSetupMessage", () => {
  it("interpolates the typed arguments without terminal layout or quoting", () => {
    const ref = setupMessageRef("guided.active-rc-missing", {
      shell: "zsh",
      path: "/tmp/a path/.zshrc",
    });

    expect(resolveSetupMessage(ref)).toBe("Active zsh rc file not found: /tmp/a path/.zshrc");
  });

  it("falls back to terminal copy when a graphical variant is absent", () => {
    const ref = setupMessageRef("completion.core");

    expect(resolveSetupMessage(ref, "graphical")).toBe("Core setup complete.");
  });

  it("interpolates setup-managed formulas into recovery copy", () => {
    expect(
      resolveSetupMessage(
        setupMessageRef("next.install-bun", { formula: "canonical-bun-formula" }),
      ),
    ).toBe("Install Bun (brew install canonical-bun-formula).");
    expect(
      resolveSetupMessage(
        setupMessageRef("next.install-diff-viewer", { formula: "canonical-hunk-formula" }),
      ),
    ).toBe("Install Hunk (brew install canonical-hunk-formula).");
  });

  it("rejects unknown ids and missing interpolation arguments at runtime", () => {
    expect(() =>
      resolveSetupMessage({ id: "unknown.message" } as unknown as SetupMessageRef),
    ).toThrow("Unknown setup message");
    expect(() =>
      resolveSetupMessage({ id: "progress.start", args: {} } as unknown as SetupMessageRef),
    ).toThrow("Missing setup message argument label");
  });
});
