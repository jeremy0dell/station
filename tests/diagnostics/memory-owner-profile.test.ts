import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMemoryProfilePlan,
  checkMemoryProfilePrerequisites,
} from "../../scripts/test-runners/run-memory-owner-profile.mjs";
import {
  buildIncidentSchedule,
  createIncidentGraph,
  INCIDENT_GRAPH,
  INCIDENT_WORKLOAD,
} from "../../tests/performance/memory/incidentFixture.mjs";
import {
  buildOwnerProbePlan,
  classifyRetention,
  OWNER_PROBES,
  STEPPED_COUNTS,
} from "../../tests/performance/memory/ownerProbe.mjs";
import { startProcessSampler } from "../../tests/performance/memory/processSampler.mjs";

describe("#749 deterministic memory-profile contract", () => {
  it("builds the exact incident-shaped graph and schedule", () => {
    const graph = createIncidentGraph("/tmp/station-memory-profile-fixture");
    const schedule = buildIncidentSchedule(graph);

    expect(graph.projects).toHaveLength(INCIDENT_GRAPH.projects);
    expect(graph.sessionCount).toBe(INCIDENT_GRAPH.projects * INCIDENT_GRAPH.sessionsPerProject);
    expect(schedule).toHaveLength(INCIDENT_WORKLOAD.reports);
    expect(new Set(schedule.map((entry) => entry.batch)).size).toBe(INCIDENT_WORKLOAD.batches);
    expect(
      schedule.filter((entry) => entry.batch < INCIDENT_WORKLOAD.threeReportBatches),
    ).toHaveLength(INCIDENT_WORKLOAD.threeReportBatches * 3);
    expect(
      Date.parse(schedule.at(-1)?.report.observedAt ?? "") -
        Date.parse(schedule[0].report.observedAt),
    ).toBe(INCIDENT_WORKLOAD.durationMs + 10);
    expect(new Set(schedule.map((entry) => entry.report.reportId)).size).toBe(
      INCIDENT_WORKLOAD.reports,
    );
  });

  it("keeps the matrix order explicit across runtime, artifact, and role boundaries", () => {
    const plan = buildMemoryProfilePlan();
    expect(plan).toHaveLength(1 * 2 * 4);
    expect([...new Set(plan.map((cell) => cell.version))]).toEqual(["1.4.0"]);
    expect(plan[0]).toEqual({ version: "1.4.0", mode: "source", role: "observer" });
    expect(plan.at(-1)).toEqual({ version: "1.4.0", mode: "compiled", role: "host" });
  });

  it("keeps retained-owner probes bounded and provider-neutral", () => {
    expect(OWNER_PROBES.map((probe) => probe.sibling)).toEqual([
      "750",
      "750",
      "751",
      "751",
      "751",
      "752",
      "752",
    ]);
    expect(buildOwnerProbePlan()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "observer-event-bus-stalled", counts: STEPPED_COUNTS }),
        expect.objectContaining({ id: "transport-stalled-peer", counts: STEPPED_COUNTS }),
      ]),
    );
  });

  it("distinguishes allocator high-water from monotonic retained growth", () => {
    expect(
      classifyRetention({
        samples: [
          { operations: 0, retainedBytes: 100, elapsedMs: 0 },
          { operations: 1, retainedBytes: 1_000, elapsedMs: 1 },
          { operations: 2, retainedBytes: 100, elapsedMs: 2 },
        ],
        idleSlope: 500,
      }).classification,
    ).toBe("high-water-or-flat");
    expect(
      classifyRetention({
        samples: [
          { operations: 0, retainedBytes: 100, elapsedMs: 0 },
          { operations: 1, retainedBytes: 1_100, elapsedMs: 1 },
          { operations: 2, retainedBytes: 2_100, elapsedMs: 2 },
        ],
        idleSlope: 10,
      }).classification,
    ).toBe("monotonic");
  });

  it("reports dirty or unbuilt check state without launching a Station process", async () => {
    const result = await checkMemoryProfilePrerequisites({
      bun: { "1.4.0": "/does/not/exist" },
    });
    expect(result.ready).toBe(false);
    expect(result.missing.some((message) => message.includes("does/not/exist"))).toBe(true);
  });

  it("records User Timing counts and keeps clearing an explicit probe diagnostic-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-memory-sampler-"));
    const path = join(root, "samples.jsonl");
    performance.mark("memory-profile-test-start");
    performance.mark("memory-profile-test-end");
    performance.measure(
      "memory-profile-test",
      "memory-profile-test-start",
      "memory-profile-test-end",
    );
    try {
      const sampler = await startProcessSampler({ path, intervalMs: 1_000, clearUserTiming: true });
      await sampler.snapshot("test");
      sampler.dispose();
      const records = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const samples = records.filter((record) => record.event === "sample");
      expect(samples.length).toBe(2);
      expect(samples[0]).toMatchObject({
        phase: "initial",
        userTimingCleared: true,
      });
      expect(samples[0].userTiming).toMatchObject({
        marks: expect.any(Number),
        measures: expect.any(Number),
      });
      expect(records.at(-1)).toMatchObject({ event: "session-end", samples: 2 });
    } finally {
      performance.clearMarks();
      performance.clearMeasures();
      await rm(root, { recursive: true, force: true });
    }
  });
});
