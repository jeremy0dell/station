import type { ProviderId } from "@station/contracts";
import { describe, expect, it } from "vitest";
import {
  selectNewSessionHarnessChoices,
  selectNewSessionHarnessOptions,
} from "../../../src/selectors/harnessChoices.js";
import { createDashboardSnapshot } from "../../fixtures/snapshots.js";

describe("harness choices", () => {
  it("keys New Session harnesses from the shared shortcut grammar", () => {
    const snapshot = {
      ...createDashboardSnapshot(),
      harnesses: [
        { id: "codex", label: "codex" },
        { id: "pi", label: "pi" },
      ],
    };
    const api = snapshot.projects.find((project) => project.id === "api");
    if (api === undefined) throw new Error("missing api Project");

    expect(
      selectNewSessionHarnessChoices(snapshot, api).map((choice) => [choice.key, choice.value.id]),
    ).toEqual([
      ["1", "codex"],
      ["2", "pi"],
    ]);
  });

  it("carries an update pair only when the snapshot knows both versions differ", () => {
    const base = createDashboardSnapshot();
    const snapshot = {
      ...base,
      harnesses: [
        {
          id: "codex" as ProviderId,
          label: "codex",
          installedVersion: "0.3.0",
          latestVersion: "0.4.0",
          updateAvailable: true,
        },
        { id: "opencode" as ProviderId, label: "opencode", installedVersion: "1.0.0" },
      ],
    };
    const project = snapshot.projects[0];
    if (project === undefined) throw new Error("fixture requires a Project");

    const options = selectNewSessionHarnessOptions(snapshot, project);
    expect(options.find((option) => option.id === "codex")?.update).toEqual({
      installed: "0.3.0",
      latest: "0.4.0",
    });
    expect(options.find((option) => option.id === "opencode")?.update).toBeUndefined();
  });
});
