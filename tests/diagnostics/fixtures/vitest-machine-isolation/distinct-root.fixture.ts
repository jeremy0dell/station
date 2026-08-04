import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, it } from "vitest";

it("uses a private per-file machine root", async () => {
  const machineRoot = process.env.STATION_TEST_MACHINE_ROOT;
  const resultDirectory = process.env.STATION_TEST_MACHINE_RESULT_DIR;
  const hostileRoot = process.env.STATION_TEST_MACHINE_HOSTILE_ROOT;
  if (machineRoot === undefined || resultDirectory === undefined || hostileRoot === undefined) {
    throw new Error("Machine isolation fixture controls are missing.");
  }

  await mkdir(resultDirectory, { recursive: true });
  await writeFile(
    join(resultDirectory, "distinct-root.json"),
    JSON.stringify({ machineRoot }),
    "utf8",
  );

  expect(machineRoot).not.toBe(hostileRoot);
  expect(basename(machineRoot)).toMatch(/^s-/);
  expect(process.env.HOME).toBe(join(machineRoot, "home"));

  if (process.env.STATION_TEST_MACHINE_FAIL === "1") {
    throw new Error("intentional machine-isolation fixture failure");
  }
});
