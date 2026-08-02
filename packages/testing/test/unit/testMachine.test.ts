import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertPathInsideTestMachineRoot } from "@station/testing";
import { afterAll, describe, expect, it, vi } from "vitest";

const fallbackMachineRoots: string[] = [];

afterAll(() => {
  for (const root of fallbackMachineRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("assertPathInsideTestMachineRoot", () => {
  it("accepts a path inside the physical machine root", async () => {
    const root = machineRoot();
    const fixture = await mkdtemp(join(root, "tmp", "path-assertion-"));

    expect(() =>
      assertPathInsideTestMachineRoot(join(fixture, "missing", "file"), "fixture"),
    ).not.toThrow();
  });

  it("rejects a lexical parent escape", () => {
    const root = machineRoot();

    expect(() => assertPathInsideTestMachineRoot(join(root, "..", "escaped"), "fixture")).toThrow(
      /fixture must stay inside STATION_TEST_MACHINE_ROOT/,
    );
  });

  it("rejects a symlink escape", async () => {
    const root = machineRoot();
    const fixture = join(root, "tmp", "symlink-assertion");
    await mkdir(fixture, { recursive: true });
    const link = join(fixture, "outside");
    await symlink(dirname(root), link);

    expect(() => assertPathInsideTestMachineRoot(join(link, "escaped"), "fixture")).toThrow(
      /fixture must stay inside STATION_TEST_MACHINE_ROOT/,
    );
  });

  it("requires the machine root variable", () => {
    vi.stubEnv("STATION_TEST_MACHINE_ROOT", "");

    expect(() => assertPathInsideTestMachineRoot("/tmp/example", "fixture")).toThrow(
      /fixture requires STATION_TEST_MACHINE_ROOT/,
    );
  });
});

function machineRoot(): string {
  const configuredRoot = process.env.STATION_TEST_MACHINE_ROOT;
  if (configuredRoot !== undefined) return configuredRoot;

  const root = mkdtempSync(join(tmpdir(), "station-test-machine-helper-"));
  mkdirSync(join(root, "tmp"));
  fallbackMachineRoots.push(root);
  vi.stubEnv("STATION_TEST_MACHINE_ROOT", root);
  return root;
}
