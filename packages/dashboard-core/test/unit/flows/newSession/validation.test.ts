import { describe, expect, it } from "vitest";
import { newSessionActionEnabled } from "../../../../src/flows/newSession/actions.js";
import { createNewSessionFlow } from "../../../../src/flows/newSession/flow.js";
import { validateNewSessionCreate } from "../../../../src/flows/newSession/validation.js";
import { selectNewSessionHarnessOptions } from "../../../../src/selectors/harnessChoices.js";
import { createHarnessSnapshot } from "./support.js";

describe("New Session validation", () => {
  it("orders agent options from configured harnesses without a project default", () => {
    const snapshot = createHarnessSnapshot();
    const api = snapshot.projects.find((project) => project.id === "api");
    if (api === undefined) throw new Error("missing api project");

    expect(selectNewSessionHarnessOptions(snapshot, api).map((option) => option.id)).toEqual([
      "codex",
      "opencode",
      "scripted",
    ]);
  });

  it("blocks unavailable agents while allowing degraded and unknown agents", () => {
    const snapshot = createHarnessSnapshot({
      codex: "unavailable",
      opencode: "degraded",
    });
    const opened = createNewSessionFlow(snapshot, "aaaaaa");
    if (opened === undefined) throw new Error("expected a flow");

    expect(validateNewSessionCreate(snapshot, opened)).toMatchObject({
      ok: false,
      error: {
        code: "HARNESS_PROVIDER_UNAVAILABLE",
      },
    });
    expect(newSessionActionEnabled(snapshot, opened, "review.create")).toBe(false);

    const opencode = { ...opened, selectedHarness: "opencode" };
    expect(validateNewSessionCreate(snapshot, opencode)).toMatchObject({
      ok: true,
      harnessProvider: "opencode",
    });
    expect(newSessionActionEnabled(snapshot, opencode, "review.create")).toBe(true);

    const unknown = { ...opened, selectedHarness: "scripted" };
    expect(validateNewSessionCreate(snapshot, unknown)).toMatchObject({
      ok: true,
      harnessProvider: "scripted",
    });
  });
});
