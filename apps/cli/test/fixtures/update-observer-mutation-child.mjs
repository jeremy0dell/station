import { appendFileSync, fstatSync } from "node:fs";
import { runObserverCommand } from "@station/cli/internal";

const socketPath = "/tmp/station-update-observer-commitment.sock";
const buildSelector = `2.0.0+station.${"b".repeat(64)}`;
const processTokenB = "223e4567-e89b-42d3-a456-426614174000";
const scenario = process.env.STATION_TEST_OBSERVER_MUTATION_SCENARIO ?? "exact";
const recordPath = process.env.STATION_TEST_OBSERVER_MUTATION_RECORD;
let running = false;

function record(value) {
  if (recordPath !== undefined) appendFileSync(recordPath, `${value}\n`, "utf8");
}

function privateObserver(pid, processToken) {
  return {
    pid,
    osStartTime: pid === 4242 ? "Fri Aug 21 12:00:00 2026" : "Fri Aug 21 12:00:01 2026",
    processToken,
    buildSelector,
    socketPath,
  };
}

function inspection() {
  switch (scenario) {
    case "owner-drift":
      return {
        evidence: {
          status: "exact",
          buildVersion: buildSelector,
          relation: "matching-target",
          replacementAdmission: "exact-build",
          health: "healthy",
          recovery: {
            status: "assessed",
            assessment: {
              schemaVersion: 1,
              resumeEnabled: true,
              providerCapabilities: [],
              sessions: [],
            },
          },
        },
        privateEvidence: {
          observer: privateObserver(4343, processTokenB),
          selectedRecoveryHandles: [],
        },
      };
    case "unknown-after-absent":
      return {
        evidence: {
          status: "unknown",
          reason: "identity-unavailable",
          error: {
            tag: "UpdatePreflightError",
            code: "UPDATE_PREFLIGHT_OBSERVER_IDENTITY_UNAVAILABLE",
            message: "Observer identity is unavailable.",
          },
        },
        privateEvidence: { selectedRecoveryHandles: [] },
      };
    case "handle-drift":
      return {
        evidence: { status: "absent" },
        privateEvidence: {
          selectedRecoveryHandles: [
            { sessionId: "session-a", selectedHandleId: "selected-handle-b" },
          ],
        },
      };
    case "exact":
      return {
        evidence: { status: "absent" },
        privateEvidence: { selectedRecoveryHandles: [] },
      };
    default:
      throw new Error(`Unknown Observer mutation scenario: ${scenario}`);
  }
}

try {
  const result = await runObserverCommand(
    ["start", "--internal-update-commitment"],
    {
      config: { observer: { socketPath } },
      updateMutationInspection: async () => inspection(),
    },
    {
      buildVersion: buildSelector,
      probeSocket: async () => ({ status: "absent" }),
      clientFactory: () => ({
        health: async () => {
          if (!running) throw new Error("stopped");
          return {
            schemaVersion: "0.11.0",
            status: "healthy",
            pid: 5000,
            startedAt: "2026-08-21T12:00:02.000Z",
            version: buildSelector,
            socketPath,
          };
        },
      }),
      spawnObserver: async () => {
        try {
          fstatSync(3);
          throw new Error("private commitment descriptor remained open during mutation");
        } catch (error) {
          if (error?.code !== "EBADF") throw error;
        }
        record("fd-closed");
        record("start");
        running = true;
        return { pid: 5000, unref() {} };
      },
      sleep: async () => undefined,
    },
  );
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
