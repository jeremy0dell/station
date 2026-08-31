import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ProjectIdSchema, SessionIdSchema, WorktreeIdSchema } from "@station/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CommandGetResult } from "../../../apps/cli/src/commands/command";
import type { GroupCommandResult } from "../../../apps/cli/src/commands/group/result";
import type { SessionCommandResult } from "../../../apps/cli/src/commands/session/result";
import { findRowByBranch } from "../../support/real-station/assertions";
import {
  continuePastCodexStartupPrompts,
  createRealCodexFixture,
  readCodexSessionStartWitness,
  writeFailureBundle,
} from "../../support/real-station/codex";
import { writeRealStationConfig } from "../../support/real-station/config";
import {
  type RealE2eEnvironment,
  realE2eEnabled,
  requireRealE2eEnvironment,
} from "../../support/real-station/env";
import { CleanupStack, runStationJson } from "../../support/real-station/process";
import { createRealObserverClient, waitForSnapshot } from "../../support/real-station/protocol";
import { createRealIngressWitness } from "../../support/real-station/recovery";
import { createRealTempRepo, uniqueBranch } from "../../support/real-station/repo";
import { closeRealTmuxEndpoint, killTmuxSession } from "../../support/real-station/tmux";
import { removeRealWorktrunkWorktree } from "../../support/real-station/worktrunk";

const execFileAsync = promisify(execFile);
const describePilot =
  realE2eEnabled() && process.env.STATION_CLI_UX_PILOT === "1" ? describe : describe.skip;
const pilotModel = "gpt-5.6-luna";
const pilotReasoning = "xhigh";
const reportRelativePath = ".station-real-e2e/cli-ux-pilot-report.json";

const AgentReportSchema = z
  .object({
    status: z.enum(["PASS", "FAIL"]),
    sessionId: SessionIdSchema,
    projectId: ProjectIdSchema,
    commandPath: z.string().min(1),
    session: z
      .object({
        projectId: ProjectIdSchema,
        worktreeId: WorktreeIdSchema,
        title: z.string().min(1),
        harness: z.literal("codex"),
        terminalProvider: z.literal("tmux"),
        groupIds: z.array(z.string().min(1)),
      })
      .strict(),
    commands: z.array(z.string().min(1)).min(7),
    findings: z.array(z.string()),
  })
  .strict();

const CommandAuditSchema = z
  .object({
    invokedAt: z.iso.datetime({ offset: true }),
    sessionId: SessionIdSchema,
    argv: z.array(z.string()),
  })
  .strict();

const ModelAuditSchema = z
  .object({
    invokedAt: z.iso.datetime({ offset: true }),
    provider: z.literal("codex"),
    model: z.literal(pilotModel),
    reasoning: z.literal(pilotReasoning),
  })
  .strict();

type SessionCreateCliResult = Extract<SessionCommandResult, { action: "create" }>;
type SessionGetCliResult = Extract<SessionCommandResult, { action: "get" }>;
type SessionCloseCliResult = Extract<SessionCommandResult, { action: "close" }>;
type GroupListCliResult = Extract<GroupCommandResult, { action: "list" }>;

describePilot("real first-class CLI UX pilot", () => {
  let env: RealE2eEnvironment;
  let cleanup: CleanupStack;

  beforeAll(async () => {
    expect(process.env.STATION_CLI_UX_PILOT_MODEL).toBe(pilotModel);
    expect(process.env.STATION_CLI_UX_PILOT_REASONING).toBe(pilotReasoning);
    env = await requireRealE2eEnvironment({ worktrunk: true, tmux: true, codex: true });
  });

  afterEach(async () => {
    await cleanup?.run();
  });

  it("lets a Luna-xhigh Codex agent discover its exact ungrouped tmux session", async () => {
    cleanup = new CleanupStack();
    const durationMs = pilotDurationMs();
    const repo = await createRealTempRepo(env);
    cleanup.defer(repo.cleanup);
    const ingress = await createRealIngressWitness({ env, rootPath: repo.root });
    const codex = await createRealCodexFixture({ env: ingress.env, repo });
    const modelAuditPath = join(repo.root, "model-audit.jsonl");
    const modelCommand = await writeModelPinnedCodexWrapper(
      repo.root,
      codex.codexCommand,
      modelAuditPath,
    );
    const commandAuditPath = join(repo.root, "stn-command-audit.jsonl");
    const pilotEnv = await writePilotStationWrapper(codex.env, repo.root, commandAuditPath);
    const config = await writeRealStationConfig({
      env: pilotEnv,
      repo,
      codexCommand: modelCommand,
      installCodexHooks: true,
    });
    cleanup.defer(() => closeRealTmuxEndpoint(config.tmuxEndpoint));
    const hooks = await codex.installHooks(config);
    cleanup.defer(async () => {
      await runStationJson(pilotEnv, {
        configPath: config.configPath,
        args: ["observer", "stop"],
      });
    });
    const branch = uniqueBranch("cli-ux-pilot");
    cleanup.defer(async () => {
      await removeRealWorktrunkWorktree({ env: pilotEnv, config, repo, branch });
    });
    await writePreliminarySkill(codex.codexHome);

    const runId = `ux-pilot-${Date.now()}`;
    const caseId = "T-CODEX-P1";
    const title = `${runId} ${caseId}`;
    const prompt = pilotPrompt({
      runId,
      caseId,
      expectedCommandPath: pilotEnv.stationBin,
      expectedTitle: title,
    });
    await writeFile(join(repo.root, "initial-prompt.txt"), `${prompt}\n`, "utf8");
    const hardStopAt = Date.now() + durationMs;

    let createResult: SessionCreateCliResult | undefined;
    let sessionGet: SessionGetCliResult | undefined;
    let groupList: GroupListCliResult | undefined;
    let agentReport: z.infer<typeof AgentReportSchema> | undefined;
    let sessionId: string | undefined;
    let worktreePath: string | undefined;
    let failure: unknown;
    let closeEvidence: Awaited<ReturnType<typeof closeExactSession>> | undefined;
    let closePromise: Promise<Awaited<ReturnType<typeof closeExactSession>>> | undefined;
    let hardStopTmuxPromise: Promise<void> | undefined;
    const hardStopTmux = () => {
      hardStopTmuxPromise ??= killTmuxSession(config.tmuxEndpoint, config.tmuxSession);
      return hardStopTmuxPromise;
    };
    const requestClose = () => {
      if (sessionId === undefined) return undefined;
      closePromise ??= closeExactSession({
        env: pilotEnv,
        configPath: config.configPath,
        sessionId,
        hardStopAt,
      });
      return closePromise;
    };
    const hardStopTimer = setTimeout(() => {
      void hardStopTmux().catch(() => undefined);
      void requestClose()?.catch(() => undefined);
    }, durationMs);

    try {
      createResult = await runStationJson<SessionCreateCliResult>(pilotEnv, {
        configPath: config.configPath,
        args: [
          "session",
          "create",
          config.projectId,
          "--branch",
          branch,
          "--title",
          title,
          "--terminal",
          "tmux",
          "--harness",
          "codex",
          "--layout",
          "agent-only",
          "--ungrouped",
          "--prompt-stdin",
          "--timeout-ms",
          "180000",
          "--json",
        ],
        stdin: prompt,
        timeoutMs: 190_000,
      });
      expect(createResult).toMatchObject({
        action: "create",
        outcome: { status: "succeeded" },
        convergence: { status: "confirmed" },
      });
      if (createResult.outcome.status !== "succeeded") {
        throw new Error(`session create returned ${createResult.outcome.status}.`);
      }
      sessionId = createResult.outcome.result.sessionId;
      expect(createResult.outcome.result).toMatchObject({
        type: "session.create",
        projectId: config.projectId,
        requestedPlacement: "detached",
        resolvedPlacement: {
          provider: "tmux",
          presentation: "detached",
        },
      });
      expect(createResult.outcome.result.resolvedGroupId).toBeUndefined();

      const createRecord = await runStationJson<CommandGetResult>(pilotEnv, {
        configPath: config.configPath,
        args: ["command", "get", createResult.outcome.receipt.commandId],
      });
      expect(createRecord.command).toMatchObject({
        id: createResult.outcome.receipt.commandId,
        type: "session.create",
        status: "succeeded",
      });

      sessionGet = await runStationJson<SessionGetCliResult>(pilotEnv, {
        configPath: config.configPath,
        args: ["session", "get", sessionId, "--require-running", "--json"],
      });
      expect(sessionGet).toMatchObject({
        action: "get",
        session: {
          sessionId,
          projectId: config.projectId,
          worktreeId: createResult.outcome.result.worktreeId,
          title,
          harness: { provider: "codex" },
          terminal: { provider: "tmux" },
        },
      });

      groupList = await runStationJson<GroupListCliResult>(pilotEnv, {
        configPath: config.configPath,
        args: ["group", "list", "--project", config.projectId, "--require-running", "--json"],
      });
      expect(groupList).toEqual({
        action: "list",
        filters: { project: config.projectId },
        groups: [],
      });

      const client = createRealObserverClient(config);
      const snapshot = await waitForSnapshot(
        client,
        (candidate) => {
          try {
            return findRowByBranch(candidate, branch).terminal?.hasPrimaryAgentEndpoint === true;
          } catch {
            return false;
          }
        },
        `Timed out waiting for pilot session ${sessionId} to attach its tmux pane.`,
        Math.max(1_000, Math.min(30_000, hardStopAt - Date.now())),
      );
      const row = findRowByBranch(snapshot, branch);
      worktreePath = row.path;
      await continuePastCodexStartupPrompts(config.tmuxEndpoint, config.tmuxSession, row);
      agentReport = await waitForAgentReport(
        join(row.path, reportRelativePath),
        Math.max(1, hardStopAt - Date.now()),
      );
    } catch (error) {
      failure = error;
      await writeFailureBundle({
        env: pilotEnv,
        configPath: config.configPath,
        commandId: createResult?.outcome.receipt.commandId,
      });
    } finally {
      clearTimeout(hardStopTimer);
      const pendingClose = requestClose();
      if (pendingClose !== undefined) {
        try {
          closeEvidence = await pendingClose;
        } catch (error) {
          void hardStopTmux().catch(() => undefined);
          failure =
            failure === undefined
              ? error
              : new AggregateError(
                  [failure, error],
                  "Pilot failed and exact session close failed.",
                );
        }
      } else {
        void hardStopTmux().catch(() => undefined);
      }
      if (hardStopTmuxPromise !== undefined) {
        try {
          await hardStopTmuxPromise;
        } catch (error) {
          failure =
            failure === undefined
              ? error
              : new AggregateError([failure, error], "Pilot failed and tmux hard stop failed.");
        }
      }
    }

    if (failure !== undefined) throw failure;
    if (
      createResult?.outcome.status !== "succeeded" ||
      sessionId === undefined ||
      sessionGet === undefined ||
      groupList === undefined ||
      agentReport === undefined ||
      worktreePath === undefined ||
      closeEvidence === undefined
    ) {
      throw new Error(
        "Pilot completed without the required application, agent, and cleanup evidence.",
      );
    }

    const commandAudits = await readJsonLines(commandAuditPath, CommandAuditSchema);
    for (const argv of expectedAgentInvocations(sessionId, config.projectId)) {
      expect(
        commandAudits.some((record) => sameArgs(record.argv, argv)),
        argv.join(" "),
      ).toBe(true);
    }
    expect(commandAudits.every((record) => record.sessionId === sessionId)).toBe(true);

    expect(agentReport).toMatchObject({
      status: "PASS",
      sessionId,
      projectId: config.projectId,
      commandPath: pilotEnv.stationBin,
      session: {
        projectId: config.projectId,
        worktreeId: createResult.outcome.result.worktreeId,
        title,
        harness: "codex",
        terminalProvider: "tmux",
        groupIds: [],
      },
    });

    const modelAudits = await readJsonLines(modelAuditPath, ModelAuditSchema);
    expect(modelAudits.length).toBeGreaterThan(0);
    const modelWitness = await waitForModelWitness({
      ingress,
      hooks,
      cwd: worktreePath,
      timeoutMs: 30_000,
    });
    expect(modelWitness.model).toBe(pilotModel);

    const sourceSha = await gitHead(env.repoRoot);
    expect(sourceSha).toBe(process.env.STATION_CLI_UX_PILOT_SOURCE_SHA);
    process.stdout.write(
      `STATION_CLI_UX_PILOT_RESULT=${JSON.stringify({
        runId,
        caseId,
        sourceSha,
        hardStopMs: durationMs,
        harness: "codex",
        model: pilotModel,
        reasoning: pilotReasoning,
        app: {
          status: "PASS",
          createCommandId: createResult.outcome.receipt.commandId,
          closeCommandId: closeEvidence.commandId,
          sessionId,
          worktreeId: createResult.outcome.result.worktreeId,
          placement: "detached-tmux-agent-only",
          group: "ungrouped",
        },
        agent: {
          status: agentReport.status,
          findings: agentReport.findings,
        },
        sessionClose: {
          status: "PASS",
          closeRequestedAt: closeEvidence.requestedAt,
          withinHardStop: closeEvidence.requestedAtMs <= hardStopAt + 1_000,
        },
        claude: "SKIPPED_TODO_NO_SUBSCRIPTION",
      })}\n`,
    );
  }, 420_000);
});

async function writeModelPinnedCodexWrapper(
  root: string,
  codexCommand: string,
  auditPath: string,
): Promise<string> {
  const wrapperPath = join(root, "codex-luna-xhigh.sh");
  const auditScript = [
    "const fs=require('node:fs');",
    `fs.appendFileSync(process.argv[1],JSON.stringify({invokedAt:new Date().toISOString(),provider:'codex',model:'${pilotModel}',reasoning:'${pilotReasoning}'})+'\\n');`,
  ].join("");
  await writeFile(
    wrapperPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `if [[ "\${1-}" == "login" || "\${1-}" == "--version" || "\${1-}" == "version" ]]; then`,
      `  exec ${shellQuote(codexCommand)} "$@"`,
      "fi",
      `${shellQuote(process.execPath)} -e ${shellQuote(auditScript)} ${shellQuote(auditPath)}`,
      `exec ${shellQuote(codexCommand)} --model ${shellQuote(pilotModel)} --config ${shellQuote(
        `model_reasoning_effort="${pilotReasoning}"`,
      )} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(wrapperPath, 0o700);
  return wrapperPath;
}

async function writePilotStationWrapper(
  env: RealE2eEnvironment,
  root: string,
  auditPath: string,
): Promise<RealE2eEnvironment> {
  const binDir = join(root, "pilot-bin");
  const wrapperPath = join(binDir, "stn");
  const auditScript = [
    "const fs=require('node:fs');",
    "fs.appendFileSync(process.argv[1],JSON.stringify({invokedAt:new Date().toISOString(),sessionId:process.env.STATION_SESSION_ID,argv:process.argv.slice(2)})+'\\n');",
  ].join("");
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await writeFile(
    wrapperPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `export PATH=${shellQuote(binDir)}:"$PATH"`,
      `if [[ -n "\${STATION_SESSION_ID-}" ]]; then`,
      `  ${shellQuote(process.execPath)} -e ${shellQuote(auditScript)} ${shellQuote(auditPath)} "$@"`,
      "fi",
      `exec ${shellQuote(env.stationBin)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(wrapperPath, 0o700);
  return { ...env, stationBin: wrapperPath };
}

async function writePreliminarySkill(codexHome: string): Promise<void> {
  const skillDir = join(codexHome, "skills", "station-cli-preliminary");
  await mkdir(skillDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: station-cli-preliminary",
      "description: Safely exercise Station's first-class Session and Group CLI in an isolated acceptance run.",
      "---",
      "",
      "Operate only the project and resources named by the supplied run manifest. Read command help and manuals before first use. Capture doctor/status/snapshot first and use JSON for discovery. Use only first-class `stn session`, `stn group`, `stn command get`, `stn snapshot`, and `stn observe` commands. Never use raw dispatch, fuzzy or partial identity, positional guesses, or stale IDs. Pass prompts only with `--prompt-stdin`. Tmux `--from-current` means a sibling of a proven current tmux session; `--terminal tmux` means detached. Native creation is Station UI-owned. Before and after every mutation, capture JSON and the exact command record. Stop on identity mismatch, ambiguous ownership, missing records, or failed convergence. Never update, configure, restart, or broadly clean Station, and never treat session close as authorization to delete a checkout.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function pilotPrompt(input: {
  runId: string;
  caseId: string;
  expectedCommandPath: string;
  expectedTitle: string;
}): string {
  return [
    `You are acceptance cell ${input.caseId} in disposable Station run ${input.runId}.`,
    "Use the station-cli-preliminary skill. Do not edit product code or configuration.",
    `The expected isolated-main stn command is ${input.expectedCommandPath}. Confirm it with command -v stn; stop with FAIL if it differs.`,
    "Identify yourself only from the exact STATION_SESSION_ID and STATION_PROJECT_ID environment values.",
    "",
    "1. Read `stn session --help`, `stn session get --man`, `stn group --help`, and `stn group list --man` before operating.",
    "2. Run `stn snapshot --json`.",
    '3. Run `stn session get "$STATION_SESSION_ID" --require-running --json`.',
    '4. Run `stn group list --project "$STATION_PROJECT_ID" --require-running --json`.',
    `5. Confirm the exact session uses project $STATION_PROJECT_ID, title ${input.expectedTitle}, harness codex, terminal tmux, and has no direct Group membership.`,
    `6. Create or overwrite only ${reportRelativePath} with one strict JSON object matching this shape:`,
    '{"status":"PASS|FAIL","sessionId":"exact id","projectId":"exact id","commandPath":"command -v stn output","session":{"projectId":"exact id","worktreeId":"exact id","title":"exact title","harness":"codex","terminalProvider":"tmux","groupIds":[]},"commands":["seven or more exact commands run"],"findings":["confusing help or output, if any"]}',
    "Do not run mutations, raw dispatch, setup, update, observer lifecycle, cleanup, or any command against another Station config.",
  ].join("\n");
}

function pilotDurationMs(): number {
  const parsed = Number(process.env.STATION_CLI_UX_PILOT_DURATION_MS);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 300_000) {
    throw new Error("STATION_CLI_UX_PILOT_DURATION_MS must be an integer from 1 through 300000.");
  }
  return parsed;
}

async function waitForAgentReport(
  path: string,
  timeoutMs: number,
): Promise<z.infer<typeof AgentReportSchema>> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let invalidReport: unknown;
  while (Date.now() <= deadline) {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text !== undefined) {
      try {
        const parsedJson = JSON.parse(text) as unknown;
        return AgentReportSchema.parse(parsedJson);
      } catch (error) {
        invalidReport = error;
      }
    }
    await delay(Math.min(500, Math.max(1, deadline - Date.now())));
  }
  if (invalidReport !== undefined) {
    throw new Error(`Codex wrote an invalid ${reportRelativePath}.`, { cause: invalidReport });
  }
  throw new Error(`Codex did not write ${reportRelativePath} before the hard stop.`);
}

async function closeExactSession(input: {
  env: RealE2eEnvironment;
  configPath: string;
  sessionId: string;
  hardStopAt: number;
}): Promise<{ commandId: string; requestedAt: string; requestedAtMs: number }> {
  const requestedAtMs = Date.now();
  const requestedAt = new Date(requestedAtMs).toISOString();
  const result = await runStationJson<SessionCloseCliResult>(input.env, {
    configPath: input.configPath,
    args: [
      "session",
      "close",
      input.sessionId,
      "--mode",
      "all",
      "--force",
      "--timeout-ms",
      "60000",
      "--json",
    ],
    timeoutMs: 70_000,
  });
  expect(requestedAtMs).toBeLessThanOrEqual(input.hardStopAt + 1_000);
  expect(result).toMatchObject({
    action: "close",
    outcome: { status: "succeeded" },
    convergence: { status: "confirmed" },
  });
  const record = await runStationJson<CommandGetResult>(input.env, {
    configPath: input.configPath,
    args: ["command", "get", result.outcome.receipt.commandId],
  });
  expect(record.command).toMatchObject({
    id: result.outcome.receipt.commandId,
    type: "session.close",
    status: "succeeded",
  });
  return { commandId: result.outcome.receipt.commandId, requestedAt, requestedAtMs };
}

async function waitForModelWitness(input: {
  ingress: Parameters<typeof readCodexSessionStartWitness>[0]["ingress"];
  hooks: Parameters<typeof readCodexSessionStartWitness>[0]["hooks"];
  cwd: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() <= deadline) {
    const witness = await readCodexSessionStartWitness({
      ingress: input.ingress,
      hooks: input.hooks,
      cwd: input.cwd,
      source: "startup",
    });
    if (witness !== undefined) return witness;
    await delay(500);
  }
  throw new Error("No matching Codex SessionStart model witness arrived.");
}

async function readJsonLines<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => schema.parse(JSON.parse(line) as unknown));
}

function expectedAgentInvocations(sessionId: string, projectId: string): string[][] {
  return [
    ["session", "--help"],
    ["session", "get", "--man"],
    ["group", "--help"],
    ["group", "list", "--man"],
    ["snapshot", "--json"],
    ["session", "get", sessionId, "--require-running", "--json"],
    ["group", "list", "--project", projectId, "--require-running", "--json"],
  ];
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function gitHead(root: string): Promise<string> {
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    timeout: 10_000,
  });
  return result.stdout.trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
