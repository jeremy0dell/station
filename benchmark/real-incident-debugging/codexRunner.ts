import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type ArmAccess, createArmAccess, validateExecutedCommand } from "./arms.js";
import {
  type Arm,
  type CommandRecord,
  type NeutralArmLabel,
  type Replay,
  responseJsonSchema,
  type TrialAttempt,
  TrialOutputSchema,
  type TrialTelemetry,
} from "./protocol.js";

const commandEventSchema = {
  type: "item.completed",
  itemType: "command_execution",
} as const;

export type CodexRunnerInput = {
  executable: string;
  executableArgs?: string[];
  workspaceRoot: string;
  isolatedHome: string;
  artifactRoot: string;
  prompt: string;
  arm: Arm;
  blindArm: NeutralArmLabel;
  replay: Replay;
  timeoutMs: number;
  tokenBudget: number;
  authFilePath?: string;
  environment?: Record<string, string>;
};

export type CodexRunResult = {
  attempt: TrialAttempt;
  stdoutJsonl: string;
};

export function buildTrialPrompt(input: { symptom: string; access: ArmAccess }): string {
  return [
    "You are diagnosing a frozen Station incident.",
    "Read symptom.txt and replay.json, then inspect only the copied evidence.",
    "Do not change files, start or contact an Observer, reconcile, dispatch commands, create bundles, modify setup/hooks/configuration, or use a command outside this allowlist.",
    "The incident may have insufficient evidence. Do not claim a repair, current runtime truth, success, or failure beyond the copied evidence.",
    "proximateFailure means the immediate retained failure condition at the responsible subsystem; do not substitute a reporting wrapper when copied evidence establishes a deeper failing boundary.",
    "When evidenceRoles is present, operationalBoundaryEvidence is failure-and-ownership evidence and component is logging provenance only. Otherwise, responsibleSubsystem must still name the proximate failing operation, provider boundary, parser, watcher, detector, or lifecycle supported by the retained message, code, signal, and context.",
    "A causeAssessment observed_failure with observedFailureSignals establishes that retained signal as the proximate failure; it does not establish the mechanism that produced the signal.",
    "For an observedFailureSignal, keep responsibleSubsystem at the component-and-message boundary shown by copied evidence. Do not infer an internal handler, parser, decoder, or emitter unless copied evidence names it explicitly.",
    "Set underlyingCauseDisposition to established only when copied evidence proves the mechanism beneath the proximate failure, to unknown when it does not, and to not_applicable only when no deeper mechanism is meaningful.",
    "When the proximate failure itself cannot be established, say so explicitly, set proximateEvidenceAdequacy to insufficient, and keep underlyingCauseDisposition unknown.",
    "Recommend at most two read-only diagnostic next actions; do not recommend installation, configuration changes, retries, starts, stops, replay, drain, or other mutation.",
    "Aim to finish within four commands. After a matched record provides the proximate failure, proximate ownership boundary, and an explicit observed_failure or insufficient_evidence assessment, stop searching; do not investigate an underlying mechanism that copied evidence marks unknown.",
    "When an allowed command query contains spaces, quote the query so it remains one command argument.",
    "You may execute at most 12 allowed commands; exceeding the cap is a terminal study failure.",
    "commandNumber is one-based in execution order. proximateCitation must support proximateFailure. ownershipCitation must quote a specific operation, boundary, or failure description that materially supports responsibleSubsystem; a generic component, provider name, delivery outcome, or spool outcome is insufficient by itself.",
    "Set underlyingCauseCitation only when underlyingCauseDisposition is established; otherwise it must be null.",
    "Each citation literal must occur exactly in its command output, be at most 160 characters, and contain no quote, backslash, or newline. Prefer a stable code or signal for proximateCitation, and a concise operation or failure-description literal for ownershipCitation.",
    "Return only JSON that conforms to the supplied response schema.",
    "Allowed commands:",
    formatCommandPatterns(input.access),
    "Symptom:",
    input.symptom.trim(),
  ].join("\n\n");
}

export async function runCodexTrial(input: CodexRunnerInput): Promise<CodexRunResult> {
  if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 5_000) {
    throw new Error("Codex rollout token budget must be an integer greater than 5,000.");
  }
  const access = createArmAccess({
    arm: input.arm,
    blindArm: input.blindArm,
    replay: input.replay,
  });
  await mkdir(input.isolatedHome, { recursive: true, mode: 0o700 });
  await mkdir(input.artifactRoot, { recursive: true, mode: 0o700 });
  const isolatedAuthPath = join(input.isolatedHome, "auth.json");
  if (input.authFilePath !== undefined) {
    await copyFile(input.authFilePath, isolatedAuthPath);
    await chmod(isolatedAuthPath, 0o600);
  }
  const schemaPath = join(input.artifactRoot, "response-schema.json");
  const responsePath = join(input.artifactRoot, "response.json");
  await writeFile(schemaPath, `${JSON.stringify(responseJsonSchema(), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  const args = [
    ...(input.executableArgs ?? []),
    "exec",
    "--json",
    "--color",
    "never",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--model",
    "gpt-5.6-sol",
    "--config",
    'model_reasoning_effort="high"',
    "--config",
    "sandbox_workspace_write.network_access=false",
    "--config",
    `features.rollout_budget={limit_tokens=${input.tokenBudget},reminder_at_remaining_tokens=[5000]}`,
    "--cd",
    input.workspaceRoot,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    responsePath,
    input.prompt,
  ];
  const environment = isolatedEnvironment(input);
  const startedAt = performance.now();
  const child = spawn(input.executable, args, {
    cwd: input.workspaceRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const commands: CommandRecord[] = [];
  let modelStarted = false;
  let modelCycles = 0;
  let totalTokens = 0;
  let timedOut = false;
  let spawnFailure = "";
  let policyFailure = "";
  let stdoutRemainder = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutChunks.push(chunk);
    stdoutRemainder += chunk;
    const lines = stdoutRemainder.split("\n");
    stdoutRemainder = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseCodexEvent(line);
      if (event === undefined) {
        continue;
      }
      if (event.kind === "model-started") {
        modelStarted = true;
      } else if (event.kind === "model-completed") {
        modelStarted = true;
        modelCycles += 1;
        totalTokens += event.totalTokens;
      } else if (event.kind === "command") {
        if (commands.length >= 12 && policyFailure.length === 0) {
          policyFailure = "Trial exceeded the 12-command cap.";
          child.kill("SIGTERM");
        }
        const policy = validateExecutedCommand({
          access,
          command: event.command,
          workspaceRoot: input.workspaceRoot,
        });
        if (policy.ok === false && policyFailure.length === 0) {
          policyFailure = policy.reason;
        }
        commands.push({
          argv: policy.ok ? policy.argv : [event.command],
          output: event.output,
          exitCode: event.exitCode,
        });
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
  });
  child.on("error", (error) => {
    spawnFailure = error.message;
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, input.timeoutMs);
  await waitForClose(child);
  clearTimeout(timeout);

  if (stdoutRemainder.trim().length > 0) {
    const event = parseCodexEvent(stdoutRemainder);
    if (event?.kind === "model-started") {
      modelStarted = true;
    }
  }

  const telemetry: TrialTelemetry = {
    wallTimeMs: Math.round(performance.now() - startedAt),
    commandCount: commands.length,
    modelCycles,
    totalTokens,
    outputBytes: Buffer.byteLength(stdoutChunks.join(""), "utf8"),
  };
  const stderr = [spawnFailure, ...stderrChunks].filter((value) => value.length > 0).join("\n");
  const output = await readTrialOutput(responsePath);
  const attempt = classifyTrialAttempt({
    modelStarted,
    timedOut,
    policyFailure,
    output,
    stderr,
    telemetry,
    commands,
  });
  if (input.authFilePath !== undefined) {
    await rm(isolatedAuthPath, { force: true });
  }
  return { attempt, stdoutJsonl: stdoutChunks.join("") };
}

export async function assertCodexVersion(input: {
  executable: string;
  executableArgs?: string[];
  expectedVersion: string;
}): Promise<void> {
  const child = spawn(input.executable, [...(input.executableArgs ?? []), "--version"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  });
  const version = stdout.join("").trim();
  if (code !== 0 || !version.includes(input.expectedVersion)) {
    throw new Error(
      `Pinned Codex CLI version mismatch: expected ${input.expectedVersion}; received ${version || stderr.join("").trim() || `exit ${String(code)}`}.`,
    );
  }
}

export function classifyTrialAttempt(input: {
  modelStarted: boolean;
  timedOut: boolean;
  policyFailure: string;
  output: unknown | undefined;
  stderr: string;
  telemetry: TrialTelemetry;
  commands: CommandRecord[];
}): TrialAttempt {
  if (input.policyFailure.length > 0) {
    return {
      attempt: 0,
      status: "policy-rejected",
      modelStarted: input.modelStarted,
      stderr: `${input.stderr}\nCommand policy rejected: ${input.policyFailure}`.trim(),
      telemetry: input.telemetry,
      commands: input.commands,
    };
  }
  if (input.timedOut && input.modelStarted) {
    return {
      attempt: 0,
      status: "model-timeout",
      modelStarted: true,
      stderr: input.stderr,
      telemetry: input.telemetry,
      commands: input.commands,
    };
  }
  if (input.timedOut || input.output === undefined) {
    return {
      attempt: 0,
      status: input.modelStarted ? "model-no-answer" : "infrastructure-retryable",
      modelStarted: input.modelStarted,
      stderr: input.stderr,
      telemetry: input.telemetry,
      commands: input.commands,
    };
  }
  const parsed = TrialOutputSchema.safeParse(input.output);
  if (!parsed.success) {
    return {
      attempt: 0,
      status: input.modelStarted ? "model-no-answer" : "infrastructure-retryable",
      modelStarted: input.modelStarted,
      stderr: `${input.stderr}\nInvalid final response: ${parsed.error.message}`.trim(),
      telemetry: input.telemetry,
      commands: input.commands,
    };
  }
  return {
    attempt: 0,
    status: "completed",
    modelStarted: input.modelStarted,
    stderr: input.stderr,
    telemetry: input.telemetry,
    commands: input.commands,
    output: parsed.data,
  };
}

function formatCommandPatterns(access: ArmAccess): string {
  return access.commandPatterns
    .map((pattern) => [pattern.executable, ...pattern.arguments].join(" "))
    .join("\n");
}

function isolatedEnvironment(input: CodexRunnerInput): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: input.isolatedHome,
    CODEX_HOME: input.isolatedHome,
    XDG_CONFIG_HOME: join(input.isolatedHome, "config"),
    XDG_STATE_HOME: join(input.isolatedHome, "state"),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    PATH: process.env.PATH,
    TZ: "UTC",
  };
  for (const [key, value] of Object.entries(input.environment ?? {})) {
    environment[key] = value;
  }
  return environment;
}

async function readTrialOutput(path: string): Promise<unknown | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

type ParsedEvent =
  | { kind: "model-started" }
  | { kind: "model-completed"; totalTokens: number }
  | { kind: "command"; command: string; output: string; exitCode: number | null };

function parseCodexEvent(line: string): ParsedEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  const event = codexEventSchema.safeParse(value);
  if (!event.success) {
    return undefined;
  }
  if (event.data.type === "turn.started") {
    return { kind: "model-started" };
  }
  if (event.data.type === "turn.completed") {
    return { kind: "model-completed", totalTokens: tokenCount(event.data.usage) };
  }
  if (
    event.data.type === commandEventSchema.type &&
    event.data.item?.type === commandEventSchema.itemType &&
    typeof event.data.item.command === "string"
  ) {
    return {
      kind: "command",
      command: event.data.item.command,
      output:
        typeof event.data.item.aggregated_output === "string"
          ? event.data.item.aggregated_output
          : "",
      exitCode: typeof event.data.item.exit_code === "number" ? event.data.item.exit_code : null,
    };
  }
  return undefined;
}

const codexEventSchema = z
  .object({
    type: z.string(),
    item: z
      .object({
        type: z.string(),
        command: z.string().optional(),
        aggregated_output: z.string().optional(),
        exit_code: z.number().int().optional(),
      })
      .loose()
      .optional(),
    usage: z
      .object({
        input_tokens: z.number().nonnegative().optional(),
        cached_input_tokens: z.number().nonnegative().optional(),
        output_tokens: z.number().nonnegative().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

function tokenCount(
  usage:
    | {
        input_tokens?: number | undefined;
        cached_input_tokens?: number | undefined;
        output_tokens?: number | undefined;
      }
    | undefined,
): number {
  if (usage === undefined) {
    return 0;
  }
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

async function waitForClose(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
}
