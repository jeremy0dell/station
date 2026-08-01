import { describe, expect, it, vi } from "vitest";
import { createLinePromptSetupPresenter } from "../../src/commands/setup/presenters/linePrompt.js";

describe("line prompt setup presenter", () => {
  it("reprompts invalid and out-of-range multi-selections", async () => {
    const question = vi
      .fn<(message: string) => Promise<string>>()
      .mockResolvedValueOnce("99")
      .mockResolvedValueOnce("nope")
      .mockResolvedValueOnce("2,1");
    const presenter = createLinePromptSetupPresenter({
      readline: { question, pause: vi.fn(), resume: vi.fn(), close: vi.fn() },
    });

    await expect(
      presenter.selectMany("Select agents.", [
        { value: "codex", label: "Codex" },
        { value: "opencode", label: "OpenCode" },
      ]),
    ).resolves.toEqual(["opencode", "codex"]);
    expect(question).toHaveBeenCalledTimes(3);
    expect(question.mock.calls[1]?.[0]).toContain("Select at least one available agent CLI.");
  });
});
