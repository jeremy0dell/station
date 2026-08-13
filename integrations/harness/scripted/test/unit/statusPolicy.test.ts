import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverScriptedRuns } from "../../src/stateStore";

const now = "2026-05-20T12:00:10.000Z";

describe("scripted discovery status policy", () => {
  it("ignores an empty event file instead of creating an unclassified run", async () => {
    expect(await discover([])).toEqual([]);
  });

  it("rejects malformed lifecycle events at the file boundary", async () => {
    await expect(discover([{ events: "not-an-array" }])).rejects.toMatchObject({
      code: "HARNESS_SCRIPTED_EVENT_INVALID",
    });
  });

  it("classifies recent activity as working with medium confidence during discovery", async () => {
    const [run] = await discover([
      { type: "activity", at: now, runId: "run_web_task", message: "Editing file." },
    ]);
    expect(run?.status).toMatchObject({
      value: "working",
      confidence: "medium",
      reason: "Editing file.",
    });
  });

  it("classifies reliable attention and exit signals with high confidence", async () => {
    const [attention] = await discover([
      { type: "attention", at: now, runId: "run_web_task", message: "Needs input." },
    ]);
    expect(attention?.status).toMatchObject({
      value: "needs_attention",
      confidence: "high",
      reason: "Needs input.",
    });

    const [exited] = await discover([
      { type: "exit", at: now, runId: "run_web_task", exitCode: 0 },
    ]);
    expect(exited?.status).toMatchObject({
      value: "exited",
      confidence: "high",
      reason: "Scripted agent exited with code 0.",
    });
  });
});

async function discover(events: readonly unknown[]) {
  const stateDir = await mkdtemp(join(tmpdir(), "station-scripted-discovery-status-"));
  try {
    const runsDir = join(stateDir, "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(runsDir, "run.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n"),
    );
    return await discoverScriptedRuns({
      stateDir,
      clock: { now: () => new Date(now) },
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}
