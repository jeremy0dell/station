import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type PiCompactEvent,
  parsePiCompactEvent,
  piHookPayloadToHarnessEventReport,
} from "@station/pi";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const realPiEnabled = process.env.STATION_REAL_PI === "1";
const describeRealPi = realPiEnabled ? describe : describe.skip;
const observedAt = "2026-07-19T12:00:00.000Z";
const privateQuestion = "STATION_REAL_PRIVATE_QUESTION_57253F";
const modelProvider = "station-real-faux";
const modelId = "station-real-faux-1";

type PiReport = ReturnType<typeof piHookPayloadToHarnessEventReport>;
type FauxScenario = "parallel-question" | "invalid-question" | "legacy-settlement";

type RealPiRuntime = {
  piBin: string;
  tmuxBin: string;
  fauxModulePath: string;
  stationExtensionPath: string;
  askUserExtensionPath: string;
  legacyExtensionPath: string;
};

type PiTuiRun = {
  sessionName: string;
  capturePath: string;
};

let runtime: RealPiRuntime;
let cleanupTasks: Array<() => Promise<void>> = [];

describeRealPi("real Pi status regressions", () => {
  beforeAll(async () => {
    runtime = await resolveRealPiRuntime();
  });

  afterEach(async () => {
    const tasks = cleanupTasks;
    cleanupTasks = [];
    for (const task of tasks.toReversed()) {
      await task().catch(() => undefined);
    }
  });

  it("completes markerless legacy turns when no settlement report exists", async () => {
    const run = await launchPiTui("legacy-settlement", [runtime.legacyExtensionPath]);
    const captures = await pollCaptures(
      run.capturePath,
      (records) => records.some((record) => record.event_type === "agent_end"),
      "Legacy Pi extension did not report agent_end.",
    );
    const reports = reportsFromCaptures(captures);
    const agentEnd = reportByEventType(reports, "agent_end");
    const agentEndPayload = captures.find((record) => record.event_type === "agent_end");

    expect(await capturePane(run.sessionName)).toContain("LEGACY_DONE");
    expect(captures.some((record) => record.event_type === "agent_settled")).toBe(false);
    expect(agentEndPayload).not.toHaveProperty("station_extension_protocol");
    expect(agentEnd).toMatchObject({
      status: { value: "idle", confidence: "medium" },
      turn: { kind: "turn_completed" },
    });

    await exitPiTui(run.sessionName);
  }, 120_000);

  it("holds question attention while a parallel read finishes behind the visible dialog", async () => {
    const run = await launchPiTui("parallel-question", [
      runtime.stationExtensionPath,
      runtime.askUserExtensionPath,
    ]);
    const pane = await pollPane(
      run.sessionName,
      (value) => value.includes(privateQuestion),
      "Pi did not display the real ask_user_question dialog.",
    );
    const capturesWhileOpen = await pollCaptures(
      run.capturePath,
      (records) =>
        records.some(
          (record) =>
            record.event_type === "tool_execution_end" && record.tool_call_id === "read_parallel",
        ),
      "Pi did not complete the parallel read while the question was open.",
    );
    const reportsWhileOpen = reportsFromCaptures(capturesWhileOpen);
    const promptIndex = capturesWhileOpen.findIndex(
      (record) => record.event_type === "question_prompt_open",
    );
    const readEndIndex = capturesWhileOpen.findIndex(
      (record) =>
        record.event_type === "tool_execution_end" && record.tool_call_id === "read_parallel",
    );
    const promptReport = reportsWhileOpen[promptIndex];
    const readEndReport = reportsWhileOpen[readEndIndex];

    expect(pane).toContain("Alpha");
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(readEndIndex).toBeGreaterThan(promptIndex);
    expect(promptReport).toMatchObject({
      eventType: "question_prompt_open",
      status: { value: "needs_attention", attention: "question" },
    });
    expect(readEndReport).toMatchObject({
      eventType: "tool_execution_end",
      status: { value: "needs_attention", attention: "question" },
      providerData: {
        toolCallId: "read_parallel",
        activeQuestionCallId: "question_parallel",
      },
    });
    expect(JSON.stringify(capturesWhileOpen)).not.toContain(privateQuestion);
    expect(JSON.stringify(capturesWhileOpen)).not.toContain("Alpha");

    await execFileAsync(runtime.tmuxBin, ["send-keys", "-t", run.sessionName, "Enter"]);
    const settledCaptures = await pollCaptures(
      run.capturePath,
      (records) => records.some((record) => record.event_type === "agent_settled"),
      "Pi did not settle after the real question was answered.",
    );
    const settledReports = reportsFromCaptures(settledCaptures);
    const questionEnd = settledReports.find(
      (report) =>
        report.eventType === "tool_execution_end" &&
        report.coalesceKey === "tool:question_parallel",
    );
    const agentEnd = reportByEventType(settledReports, "agent_end");
    const settled = reportByEventType(settledReports, "agent_settled");

    expect(questionEnd).toMatchObject({
      status: { value: "working", confidence: "high" },
    });
    expect(questionEnd?.status?.attention).toBeUndefined();
    expect(agentEnd).toMatchObject({ status: { value: "working" } });
    expect(agentEnd?.turn).toBeUndefined();
    expect(settled).toMatchObject({
      status: { value: "idle" },
      turn: { kind: "turn_completed" },
    });

    await exitPiTui(run.sessionName);
  }, 120_000);

  it("does not report attention when question validation rejects before a dialog opens", async () => {
    const run = await launchPiTui("invalid-question", [
      runtime.stationExtensionPath,
      runtime.askUserExtensionPath,
    ]);
    const captures = await pollCaptures(
      run.capturePath,
      (records) => records.some((record) => record.event_type === "agent_settled"),
      "Pi did not settle after rejecting the invalid question.",
    );
    const reports = reportsFromCaptures(captures);
    const questionReports = reports.filter(
      (report) => report.coalesceKey === "tool:question_rejected",
    );
    const questionEndPayload = captures.find(
      (record) =>
        record.event_type === "tool_execution_end" && record.tool_call_id === "question_rejected",
    );

    expect(captures.some((record) => record.event_type === "question_prompt_open")).toBe(false);
    expect(questionEndPayload).toMatchObject({ is_error: true });
    expect(questionReports.map((report) => report.status?.value)).toEqual(["working", "working"]);
    expect(questionReports.every((report) => report.status?.attention === undefined)).toBe(true);
    expect(JSON.stringify(captures)).not.toContain(privateQuestion);
    expect(await capturePane(run.sessionName)).not.toContain("Enter to select");

    await exitPiTui(run.sessionName);
  }, 120_000);
});

async function resolveRealPiRuntime(): Promise<RealPiRuntime> {
  const piBin = process.env.STATION_PI_BIN ?? "pi";
  const tmuxBin = process.env.STATION_TMUX_BIN ?? "tmux";
  await execFileAsync(piBin, ["--version"], { timeout: 15_000 });
  await execFileAsync(tmuxBin, ["-V"], { timeout: 10_000 });

  const configuredRoot = process.env.STATION_REAL_PI_PACKAGE_ROOT;
  const piPackageRoot =
    configuredRoot === undefined
      ? resolve(dirname(await resolveExecutablePath(piBin)), "..")
      : resolve(configuredRoot);
  const fauxModulePath = join(
    piPackageRoot,
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "providers",
    "faux.js",
  );
  const stationExtensionPath = join(
    process.cwd(),
    "integrations",
    "harness",
    "pi",
    "dist",
    "piExtension.js",
  );
  const askUserExtensionPath =
    process.env.STATION_REAL_PI_ASK_USER_EXTENSION ??
    join(
      homedir(),
      ".pi",
      "agent",
      "npm",
      "node_modules",
      "@juicesharp",
      "rpiv-ask-user-question",
      "index.ts",
    );
  const legacyExtensionPath = join(
    process.cwd(),
    "tests",
    "agent",
    "real",
    "pi",
    "fixtures",
    "station-extension-protocol-v1.mjs",
  );

  await Promise.all([
    access(fauxModulePath),
    access(stationExtensionPath),
    access(askUserExtensionPath),
    access(legacyExtensionPath),
  ]);
  return {
    piBin,
    tmuxBin,
    fauxModulePath,
    stationExtensionPath,
    askUserExtensionPath,
    legacyExtensionPath,
  };
}

async function resolveExecutablePath(command: string): Promise<string> {
  if (command.includes("/")) return realpath(command);
  const result = await execFileAsync("which", [command], { encoding: "utf8", timeout: 10_000 });
  return realpath(result.stdout.trim());
}

async function launchPiTui(scenario: FauxScenario, extensionPaths: string[]): Promise<PiTuiRun> {
  const root = await mkdtemp(join(tmpdir(), `station-real-pi-${scenario}-`));
  const worktreePath = join(root, "worktree");
  const sessionDir = join(root, "sessions");
  const piHome = join(root, "pi-home");
  const capturePath = join(root, "events.jsonl");
  const ingressPath = join(root, "capture-ingress.mjs");
  const fauxExtensionPath = join(root, "faux-provider.mjs");
  const sessionName = `station-pi-status-${process.pid}-${Date.now()}`;

  await Promise.all([
    mkdir(worktreePath, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(piHome, { recursive: true }),
  ]);
  await execFileAsync("git", ["init"], { cwd: worktreePath, timeout: 10_000 });
  await writeFile(join(worktreePath, "probe.txt"), "parallel read completed\n", "utf8");
  await writeFile(capturePath, "", "utf8");
  await writeCaptureIngress(ingressPath);
  await writeFauxProvider(fauxExtensionPath, scenario, runtime.fauxModulePath);

  cleanupTasks.push(async () => {
    await execFileAsync(runtime.tmuxBin, ["kill-session", "-t", sessionName], {
      timeout: 10_000,
    }).catch(() => undefined);
  });
  if (process.env.STATION_REAL_PI_KEEP_TEMP !== "1") {
    cleanupTasks.push(async () => rm(root, { recursive: true, force: true }));
  } else {
    process.stderr.write(`Keeping real Pi status temp root: ${root}\n`);
  }

  const args = [
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-x",
    "120",
    "-y",
    "40",
    "-c",
    worktreePath,
    "/usr/bin/env",
    `PI_CODING_AGENT_DIR=${piHome}`,
    `STATION_INGRESS_BIN=${ingressPath}`,
    `STATION_REAL_PI_CAPTURE=${capturePath}`,
    "STATION_PROJECT_ID=web",
    `STATION_WORKTREE_ID=wt_${scenario}`,
    `STATION_WORKTREE_PATH=${worktreePath}`,
    `STATION_SESSION_ID=ses_${scenario}`,
    "STATION_TERMINAL_PROVIDER=tmux",
    `STATION_TERMINAL_TARGET_ID=tmux:${sessionName}`,
    runtime.piBin,
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--approve",
  ];
  for (const extensionPath of extensionPaths) {
    args.push("--extension", extensionPath);
  }
  args.push(
    "--extension",
    fauxExtensionPath,
    "--provider",
    modelProvider,
    "--model",
    modelId,
    "--session-dir",
    sessionDir,
  );
  if (scenario === "legacy-settlement") {
    args.push("--no-tools", "Run the deterministic legacy settlement scenario.");
  } else {
    args.push("--tools", "read,ask_user_question", `Run deterministic ${scenario}.`);
  }

  await execFileAsync(runtime.tmuxBin, args, { timeout: 15_000 });
  return { sessionName, capturePath };
}

async function writeCaptureIngress(path: string): Promise<void> {
  await writeFile(
    path,
    `#!${process.execPath}\n` +
      `import { appendFileSync } from "node:fs";\n` +
      `let input = "";\n` +
      `process.stdin.setEncoding("utf8");\n` +
      `process.stdin.on("data", (chunk) => { input += chunk; });\n` +
      `process.stdin.on("end", () => {\n` +
      `  const payload = JSON.parse(input);\n` +
      `  appendFileSync(process.env.STATION_REAL_PI_CAPTURE, JSON.stringify(payload) + "\\n");\n` +
      `});\n`,
    "utf8",
  );
  await chmod(path, 0o700);
}

async function writeFauxProvider(
  path: string,
  scenario: FauxScenario,
  fauxModulePath: string,
): Promise<void> {
  const responseSource = fauxResponseSource(scenario);
  await writeFile(
    path,
    `import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from ${JSON.stringify(fauxModulePath)};\n` +
      `export default function registerStationRealFaux(pi) {\n` +
      `  const faux = createFauxCore({\n` +
      `    api: "station-real-faux-api",\n` +
      `    provider: ${JSON.stringify(modelProvider)},\n` +
      `    models: [{ id: ${JSON.stringify(modelId)}, name: "Station Real Faux", input: ["text"] }],\n` +
      `  });\n` +
      `  faux.setResponses(${responseSource});\n` +
      `  pi.registerProvider(${JSON.stringify(modelProvider)}, {\n` +
      `    baseUrl: "http://localhost:0",\n` +
      `    apiKey: "station-real-test",\n` +
      `    api: faux.api,\n` +
      `    models: [{\n` +
      `      id: ${JSON.stringify(modelId)}, name: "Station Real Faux", reasoning: false, input: ["text"],\n` +
      `      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },\n` +
      `      contextWindow: 128000, maxTokens: 4096,\n` +
      `    }],\n` +
      `    streamSimple: faux.streamSimple,\n` +
      `  });\n` +
      `}\n`,
    "utf8",
  );
}

function fauxResponseSource(scenario: FauxScenario): string {
  if (scenario === "legacy-settlement") {
    return `[fauxAssistantMessage(fauxText("LEGACY_DONE"))]`;
  }
  if (scenario === "invalid-question") {
    return `[
      fauxAssistantMessage(
        fauxToolCall("ask_user_question", {
          questions: [{
            question: ${JSON.stringify(privateQuestion)},
            header: "Invalid",
            options: [{ label: "Only", description: "Rejected before execution" }],
          }],
        }, { id: "question_rejected" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText("INVALID_DONE")),
    ]`;
  }
  return `[
    fauxAssistantMessage([
      fauxToolCall("ask_user_question", {
        questions: [{
          question: ${JSON.stringify(privateQuestion)},
          header: "Decision",
          options: [
            { label: "Alpha", description: "First deterministic option" },
            { label: "Beta", description: "Second deterministic option" },
          ],
        }],
      }, { id: "question_parallel" }),
      fauxToolCall("read", { path: "probe.txt" }, { id: "read_parallel" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxText("PARALLEL_DONE")),
  ]`;
}

async function readCaptures(path: string): Promise<PiCompactEvent[]> {
  const text = await readFile(path, "utf8");
  const events: PiCompactEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 0) events.push(parseCapturedEvent(line));
  }
  return events;
}

function parseCapturedEvent(line: string): PiCompactEvent {
  try {
    return parsePiCompactEvent(JSON.parse(line));
  } catch (error) {
    throw new Error("Could not parse a captured real Pi event.", { cause: error });
  }
}

async function pollCaptures(
  path: string,
  predicate: (records: PiCompactEvent[]) => boolean,
  message: string,
): Promise<PiCompactEvent[]> {
  return poll(async () => {
    const records = await readCaptures(path);
    return predicate(records) ? records : undefined;
  }, message);
}

async function capturePane(sessionName: string): Promise<string> {
  const result = await execFileAsync(
    runtime.tmuxBin,
    ["capture-pane", "-p", "-t", sessionName, "-S", "-200"],
    { timeout: 10_000 },
  );
  return result.stdout;
}

async function pollPane(
  sessionName: string,
  predicate: (pane: string) => boolean,
  message: string,
): Promise<string> {
  return poll(async () => {
    const pane = await capturePane(sessionName);
    return predicate(pane) ? pane : undefined;
  }, message);
}

function reportsFromCaptures(captures: PiCompactEvent[]): PiReport[] {
  return captures.map((capture, index) =>
    piHookPayloadToHarnessEventReport({
      reportId: `report_real_pi_${index}`,
      eventType: capture.event_type,
      observedAt,
      payload: capture,
    }),
  );
}

function reportByEventType(reports: PiReport[], type: string): PiReport {
  const report = reports.find((candidate) => candidate.eventType === type);
  if (report === undefined) throw new Error(`Pi did not report ${type}.`);
  return report;
}

async function exitPiTui(sessionName: string): Promise<void> {
  await execFileAsync(runtime.tmuxBin, ["send-keys", "-t", sessionName, "C-d"], {
    timeout: 10_000,
  }).catch(() => undefined);
}

async function poll<T>(probe: () => Promise<T | undefined>, message: string): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(message);
}
