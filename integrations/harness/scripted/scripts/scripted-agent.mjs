#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
const runId = required(args, "run-id");
const stateDir = required(args, "state-dir");
const scenarioPath = args.scenario;
const scenario =
  scenarioPath === undefined
    ? { events: [{ type: "started" }, { type: "exit", exitCode: 0 }] }
    : JSON.parse(await readFile(scenarioPath, "utf8"));
const runsDir = join(stateDir, "runs");
const runPath = join(runsDir, `${runId}.jsonl`);

await mkdir(runsDir, { recursive: true });

for (const event of scenario.events ?? []) {
  const scriptedEvent = {
    type: event.type,
    at: new Date().toISOString(),
    runId,
    projectId: process.env.STATION_PROJECT_ID,
    worktreeId: process.env.STATION_WORKTREE_ID,
    sessionId: process.env.STATION_SESSION_ID,
    pid: process.pid,
    cwd: process.cwd(),
    ...(event.message === undefined ? {} : { message: event.message }),
    ...(event.file === undefined ? {} : { file: event.file }),
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
    ...(event.signal === undefined ? {} : { signal: event.signal }),
  };

  if (event.type === "activity" && scenario.taskFile !== undefined) {
    await writeFile(join(process.cwd(), scenario.taskFile), scenario.taskContent ?? "", "utf8");
    scriptedEvent.file = scenario.taskFile;
  }

  await appendFile(runPath, `${JSON.stringify(scriptedEvent)}\n`, "utf8");

  if (event.type === "exit") {
    process.exitCode = typeof event.exitCode === "number" ? event.exitCode : 0;
    break;
  }
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value?.startsWith("--")) {
      const key = value.slice(2);
      result[key] = values[index + 1];
      index += 1;
    }
  }
  return result;
}

function required(values, key) {
  const value = values[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing required --${key}.`);
  }
  return value;
}
