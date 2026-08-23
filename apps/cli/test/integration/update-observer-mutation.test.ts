import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runExternalCommand } from "@station/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeUpdateObserverMutationCommitment,
  UPDATE_OBSERVER_MUTATION_FD,
  UPDATE_OBSERVER_MUTATION_MAX_BYTES,
  UpdateObserverMutationCommitmentSchema,
} from "../../src/update/updateObserverMutationCommitment.js";

const socketPath = "/tmp/station-update-observer-commitment.sock";
const buildSelector = `2.0.0+station.${"b".repeat(64)}`;
const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/update-observer-mutation-child.mjs",
);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("update Observer private mutation commitment", () => {
  it.each([
    { name: "A-to-B substitution", scenario: "owner-drift", commitment: incumbentCommitment() },
    {
      name: "unknown evidence after an absent plan",
      scenario: "unknown-after-absent",
      commitment: absentCommitment(),
    },
    {
      name: "selected recovery handle drift",
      scenario: "handle-drift",
      commitment: selectedHandleCommitment(),
    },
  ])("refuses $name before stop or start", async (testCase) => {
    const recordPath = await newRecordPath();

    await expect(
      runChild(
        testCase.scenario,
        recordPath,
        encodeUpdateObserverMutationCommitment(testCase.commitment),
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_COMMAND_FAILED" });
    await expect(readRecord(recordPath)).resolves.toBe("");
  });

  it.each([
    { name: "missing pipe", data: undefined },
    { name: "malformed bytes", data: "{" },
    {
      name: "trailing bytes",
      data: `${encodeUpdateObserverMutationCommitment(absentCommitment())}\n`,
    },
  ])("refuses $name before stop or start", async (testCase) => {
    const recordPath = await newRecordPath();

    await expect(runChild("exact", recordPath, testCase.data)).rejects.toMatchObject({
      code: "EXTERNAL_COMMAND_FAILED",
    });
    await expect(readRecord(recordPath)).resolves.toBe("");
  });

  it("closes the inherited descriptor and starts only for an exact absent commitment", async () => {
    const recordPath = await newRecordPath();
    const result = await runChild(
      "exact",
      recordPath,
      encodeUpdateObserverMutationCommitment(absentCommitment()),
    );

    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "running",
      health: { version: buildSelector, socketPath },
    });
    await expect(readRecord(recordPath)).resolves.toBe("fd-closed\nstart\n");
  });
});

function absentCommitment() {
  return UpdateObserverMutationCommitmentSchema.parse({
    kind: "station-update-observer-mutation",
    action: "start",
    target: { version: "2.0.0" },
    targetBuildSelector: buildSelector,
    socketPath,
    owner: { status: "absent" },
    selectedRecoveryHandles: [],
    planDigest: "d".repeat(64),
    nonce: "123e4567-e89b-42d3-a456-426614174000",
  });
}

function incumbentCommitment() {
  return UpdateObserverMutationCommitmentSchema.parse({
    ...absentCommitment(),
    owner: {
      status: "incumbent",
      pid: 4242,
      osStartTime: "Fri Aug 21 12:00:00 2026",
      processToken: "123e4567-e89b-42d3-a456-426614174000",
      buildSelector,
      socketPath,
    },
  });
}

function selectedHandleCommitment() {
  return UpdateObserverMutationCommitmentSchema.parse({
    ...absentCommitment(),
    selectedRecoveryHandles: [{ sessionId: "session-a", selectedHandleId: "selected-handle-a" }],
  });
}

async function newRecordPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "station-update-observer-commitment-"));
  directories.push(directory);
  return join(directory, "mutations.log");
}

async function readRecord(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : Promise.reject(error);
  }
}

function runChild(scenario: string, recordPath: string, data: string | undefined) {
  return runExternalCommand({
    command: process.execPath,
    args: [fixture],
    env: {
      STATION_TEST_OBSERVER_MUTATION_SCENARIO: scenario,
      STATION_TEST_OBSERVER_MUTATION_RECORD: recordPath,
    },
    timeoutMs: 10_000,
    ...(data === undefined
      ? {}
      : {
          inheritedInput: {
            fd: UPDATE_OBSERVER_MUTATION_FD,
            data,
            maxBytes: UPDATE_OBSERVER_MUTATION_MAX_BYTES,
          },
        }),
  });
}
