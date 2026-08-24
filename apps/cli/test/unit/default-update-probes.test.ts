import { describe, expect, it, vi } from "vitest";

const stationBuildInfo = vi.hoisted(() =>
  vi.fn(() => ({
    compiled: false,
    version: "1.0.0",
    buildIdentity: "a".repeat(64),
  })),
);

vi.mock("@station/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@station/runtime")>()),
  stationBuildInfo,
}));

import { createDefaultUpdateProbes } from "../../src/update/defaultUpdateProbes.js";

describe("default update probe composition", () => {
  it("captures one build value for every composed probe set", () => {
    const options = { cliEntryPath: "/repo/apps/cli/dist/main.js" };
    expect(createDefaultUpdateProbes(options)).toHaveLength(5);
    expect(stationBuildInfo).toHaveBeenCalledOnce();

    expect(createDefaultUpdateProbes(options)).toHaveLength(5);
    expect(stationBuildInfo).toHaveBeenCalledTimes(2);
  });
});
