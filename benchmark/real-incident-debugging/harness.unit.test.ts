import { chmod, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createArmAccess, validateCommand, validateExecutedCommand } from "./arms.js";
import {
  assertBlindPacketHasNoArmLabels,
  assertBlindPacketHasNoPrivatePaths,
  createBlindReviewPacket,
  readRunState,
} from "./artifacts.js";
import { buildTrialPrompt, classifyTrialAttempt, runCodexTrial } from "./codexRunner.js";
import {
  assertNoPrivateLabelLeakage,
  assertStudyComposition,
  frozenBaseCommit,
  frozenCandidateCommit,
  loadSealedCorpus,
  prepareTrialEvidence,
  sha256,
  sha256File,
  sha256Tree,
} from "./corpus.js";
import {
  buildBalancedSchedule,
  createCodexExecutor,
  generateBlindReviewPackets,
  preflightCorpus,
  runExperiment,
} from "./harness.js";
import {
  CorpusManifestSchema,
  defaultDecisionThresholds,
  experimentTokenBudget,
  ReplaySchema,
  responseJsonSchema,
  TrialOutputSchema,
  type TrialRecord,
  type TrialTelemetry,
} from "./protocol.js";
import { adjudicateScores, validateOutputCitations } from "./scoring.js";
import {
  analyzeExperiment,
  decideExperiment,
  incidentBlockedBootstrap,
  type ScoredTrial,
} from "./statistics.js";

const telemetry: TrialTelemetry = {
  wallTimeMs: 10,
  commandCount: 1,
  modelCycles: 1,
  totalTokens: 100,
  outputBytes: 100,
};

describe("real-incident debugging A/B harness", () => {
  it("strictly parses corpus and final response schemas", () => {
    expect(
      CorpusManifestSchema.safeParse({
        schemaVersion: 1,
        corpusVersion: "v1",
        baseCommit: "a".repeat(40),
        candidateCommit: "b".repeat(40),
        selectionSeed: "seed",
        incidents: [],
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(
      TrialOutputSchema.safeParse({
        schemaVersion: 3,
        proximateFailure: "cause",
        underlyingCauseDisposition: "unknown",
        underlyingCause: "The underlying cause is not retained.",
        responsibleSubsystem: "subsystem",
        proximateEvidenceAdequacy: "sufficient",
        nextActions: ["inspect safely"],
        proximateCitation: { commandNumber: 1, literal: "FAILURE_CODE" },
        ownershipCitation: { commandNumber: 1, literal: "provider" },
        underlyingCauseCitation: null,
        unexpected: true,
      }).success,
    ).toBe(false);
    expect(responseJsonSchema()).toMatchObject({
      properties: { schemaVersion: { type: "integer", const: 3 } },
    });
    expect(
      ReplaySchema.safeParse({
        schemaVersion: 1,
        kind: "state",
        evidencePaths: ["state"],
        stationCommands: [{ executable: "stn", arguments: ["observer", "start"] }],
        rawCommands: [{ executable: "rg", arguments: ["{query}", "state"] }],
      }).success,
    ).toBe(false);
  });

  it("stratifies the 24 held-out incidents without counting development cases", async () => {
    const corpus = await createFixtureCorpus();
    const template = corpus.incidents[0];
    expect(template).toBeDefined();
    if (template === undefined) {
      return;
    }
    const areaCounts = [
      ["configuration-startup", 3],
      ["observer-lifecycle-socket", 3],
      ["provider-operation-boundaries", 3],
      ["provider-hooks-ingress", 3],
      ["command-trace-correlation", 3],
      ["persistence-retention", 3],
      ["terminal-tui-runtime", 3],
      ["reports-evidence-adequacy", 3],
    ] as const;
    const heldOut = areaCounts.flatMap(([area, count]) =>
      Array.from({ length: count }, (_, index) => ({
        ...template,
        entry: {
          ...template.entry,
          id: `${area}-${index}`,
          cohort: "held-out" as const,
          area,
          hasExactId: true,
          hasRetainedId: false,
          hasOldOrTruncatedEvidence: true,
          correctDisposition: "success" as const,
        },
      })),
    );
    const development = Array.from({ length: 6 }, (_, index) => ({
      ...template,
      entry: {
        ...template.entry,
        id: `development-${index}`,
        cohort: "development" as const,
      },
    }));

    expect(() =>
      assertStudyComposition({ ...corpus, incidents: [...development, ...heldOut] }),
    ).not.toThrow();
  });

  it("uses deterministic balanced, interleaved randomization", async () => {
    const corpus = await createFixtureCorpus();
    const first = buildBalancedSchedule({
      incidents: corpus.incidents,
      replicates: 2,
      seed: "seed-1",
    });
    const second = buildBalancedSchedule({
      incidents: corpus.incidents,
      replicates: 2,
      seed: "seed-1",
    });

    expect(first).toEqual(second);
    expect(first).toHaveLength(6);
    for (let index = 0; index < first.length; index += 3) {
      expect(
        first
          .slice(index, index + 3)
          .map((trial) => trial.arm)
          .sort(),
      ).toEqual(["base", "candidate", "raw"]);
    }
  });

  it("verifies hashes and rejects symlink path escape", async () => {
    const corpus = await createFixtureCorpus();
    const symptomPath = join(corpus.root, "incidents", "sample-invalid-config", "symptom.txt");
    await writeFile(symptomPath, "tampered", "utf8");
    await expect(loadSealedCorpus(corpus.root)).rejects.toThrow("hash");

    const escaped = await createFixtureCorpus();
    const stateRoot = join(escaped.root, "incidents", "sample-invalid-config", "state");
    await symlink(tmpdir(), join(stateRoot, "escape"));
    await expect(loadSealedCorpus(escaped.root)).rejects.toThrow("Symlinks");
  });

  it("does not copy private corpus labels or files into a trial workspace", async () => {
    const corpus = await createFixtureCorpus();
    const incident = corpus.incidents[0];
    expect(incident).toBeDefined();
    if (incident === undefined) {
      return;
    }
    const workspace = join(corpus.root, "workspace");
    await prepareTrialEvidence({ incident, workspaceRoot: workspace });

    await expect(readFile(join(workspace, "gold.json"), "utf8")).rejects.toThrow();
    await assertNoPrivateLabelLeakage(workspace, [
      "The strict runtime config contains an unknown key.",
    ]);
    await writeFile(
      join(workspace, "leak.txt"),
      "The strict runtime config contains an unknown key.",
      "utf8",
    );
    await expect(
      assertNoPrivateLabelLeakage(workspace, [
        "The strict runtime config contains an unknown key.",
      ]),
    ).rejects.toThrow("Private corpus label leaked");
  });

  it("constructs identical base and candidate evidence and rejects mutations", async () => {
    const corpus = await createFixtureCorpus();
    await expect(
      preflightCorpus({ corpus, workspaceRoot: join(corpus.root, "preflight") }),
    ).resolves.toBeUndefined();

    const incident = corpus.incidents[0];
    expect(incident).toBeDefined();
    if (incident === undefined) {
      return;
    }
    const raw = createArmAccess({ arm: "raw", blindArm: "arm-c", replay: incident.replay });
    const prompt = buildTrialPrompt({ symptom: incident.symptom, access: raw });
    expect(prompt).toContain("Recommend at most two read-only diagnostic next actions");
    expect(prompt).toContain(
      "ownershipCitation must quote a specific operation, boundary, or failure description",
    );
    expect(
      validateCommand({
        access: raw,
        argv: ["find", "state", "-delete"],
        workspaceRoot: corpus.root,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCommand({
        access: raw,
        argv: ["stn", "debug", "logs"],
        workspaceRoot: corpus.root,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCommand({
        access: raw,
        argv: [
          "sqlite3",
          "-readonly",
          "state/observer.sqlite",
          "WITH x AS (DELETE FROM t) SELECT 1",
        ],
        workspaceRoot: corpus.root,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateExecutedCommand({
        access: raw,
        command: "/bin/zsh -lc 'rg failure state'",
        workspaceRoot: corpus.root,
      }),
    ).toMatchObject({ ok: true, argv: ["rg", "failure", "state"] });
    expect(
      validateExecutedCommand({
        access: raw,
        command: `/bin/zsh -lc 'rg "$(stn debug logs)" state'`,
        workspaceRoot: corpus.root,
      }),
    ).toMatchObject({ ok: false });
  });

  it("grounds field-specific citations by recorded output instead of command route", () => {
    const output = {
      schemaVersion: 3 as const,
      proximateFailure: "cause",
      underlyingCauseDisposition: "unknown" as const,
      underlyingCause: "The underlying cause is not retained.",
      responsibleSubsystem: "subsystem",
      proximateEvidenceAdequacy: "sufficient" as const,
      nextActions: ["inspect"],
      proximateCitation: { commandNumber: 1, literal: "CONFIG_VALIDATION_FAILED" },
      ownershipCitation: { commandNumber: 1, literal: "configuration" },
      underlyingCauseCitation: null,
    };
    expect(
      validateOutputCitations(output, ["station configuration: CONFIG_VALIDATION_FAILED"]),
    ).toEqual({
      valid: true,
      failures: [],
    });
    expect(
      validateOutputCitations(output, ["raw configuration: CONFIG_VALIDATION_FAILED"]),
    ).toEqual({
      valid: true,
      failures: [],
    });
  });

  it("removes arm identities from blind packets", () => {
    const record = completedRecord("base", "arm-a");
    const packet = createBlindReviewPacket({ record, symptom: "A symptom without arm labels." });
    expect(packet).not.toHaveProperty("arm");
    expect(packet).not.toHaveProperty("blindArm");
    expect(() =>
      assertBlindPacketHasNoArmLabels(packet, ["base", "candidate", "raw", "arm-a"]),
    ).not.toThrow();
  });

  it("removes private absolute paths from blind packets", () => {
    const record = completedRecord("base", "arm-a");
    const attempt = record.attempts[0];
    expect(attempt).toBeDefined();
    if (attempt !== undefined) {
      attempt.commands[0] = {
        argv: ["stn", "debug", "logs", "failure"],
        output: "/Users/private/study/candidate/raw/workspaces/evidence/state/logs/observer.jsonl",
        exitCode: 0,
      };
    }
    const packet = createBlindReviewPacket({ record, symptom: "Copied evidence failed." });
    expect(() => assertBlindPacketHasNoPrivatePaths(packet)).not.toThrow();
    expect(JSON.stringify(packet)).toContain("[REDACTED_PATH]/observer.jsonl");
  });

  it("resumes without duplicate paid turns and emits complete fake-Codex artifacts", async () => {
    const corpus = await createFixtureCorpus();
    const fakeCodex = await createFakeCodex(corpus.root);
    const artifactRoot = join(corpus.root, "artifacts");
    const input = {
      corpus,
      artifactRoot,
      replicates: 1,
      seed: "run-seed",
      stationExecutables: {
        base: { path: process.execPath, commit: frozenBaseCommit },
        candidate: { path: process.execPath, commit: frozenCandidateCommit },
      },
      executor: createCodexExecutor({
        executable: process.execPath,
        executableArgs: [fakeCodex],
        expectedVersion: "codex-cli 0.146.0",
        timeoutMs: 10_000,
        tokenBudget: experimentTokenBudget,
      }),
    };
    const firstPlan = buildBalancedSchedule({
      incidents: corpus.incidents,
      replicates: 1,
      seed: "run-seed",
    })[0];
    expect(firstPlan).toBeDefined();
    if (firstPlan === undefined) {
      return;
    }
    const interruptedArtifactRoot = join(
      artifactRoot,
      "raw",
      "runner",
      firstPlan.trialId,
      "attempt-1",
    );
    await mkdir(join(interruptedArtifactRoot, "command-bin"), { recursive: true });
    await symlink(process.execPath, join(interruptedArtifactRoot, "command-bin", "rg"));
    await writeFile(join(interruptedArtifactRoot, "response.json"), "stale response", "utf8");

    const first = await runExperiment(input);
    expect(Object.values(first.state.records)).toHaveLength(3);
    expect(
      Object.values(first.state.records).every(
        (record) =>
          record.attempts.at(-1)?.status === "completed" &&
          record.attempts.at(-1)?.telemetry.totalTokens === 15,
      ),
    ).toBe(true);
    expect(
      await generateBlindReviewPackets({ paths: first.paths, corpus, state: first.state }),
    ).toBe(3);
    const second = await runExperiment(input);
    expect(second.state).toEqual(first.state);
    expect(await readRunState<typeof first.state>(second.paths)).toEqual(first.state);
    await expect(
      readFile(
        join(
          artifactRoot,
          "raw",
          "trials",
          first.state.schedule[0]?.trialId ?? "",
          "attempt-1-codex-events.jsonl",
        ),
        "utf8",
      ),
    ).resolves.toContain("turn.completed");
    expect(await readdir(join(artifactRoot, "blind", "packets"))).toHaveLength(3);
  });

  it("rejects a trial that exceeds the 12-command cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-command-cap-"));
    const workspaceRoot = join(root, "workspace");
    await mkdir(join(workspaceRoot, "state"), { recursive: true });
    const fakeCodex = await createFakeCodex(root, 13);
    const result = await runCodexTrial({
      executable: process.execPath,
      executableArgs: [fakeCodex],
      workspaceRoot,
      isolatedHome: join(root, "home"),
      artifactRoot: join(root, "artifacts"),
      prompt: "Inspect the copied evidence.",
      arm: "raw",
      blindArm: "arm-c",
      replay: {
        schemaVersion: 1,
        kind: "state",
        evidencePaths: ["state"],
        stationCommands: [],
        rawCommands: [{ executable: "rg", arguments: ["failure", "state"] }],
      },
      timeoutMs: 10_000,
      tokenBudget: experimentTokenBudget,
      environment: { PATH: process.env.PATH ?? "" },
    });
    expect(result.attempt.status).toBe("policy-rejected");
    expect(result.attempt.telemetry.commandCount).toBe(13);
  });

  it("distinguishes retryable infrastructure failures from model timeouts", () => {
    const retryable = classifyTrialAttempt({
      modelStarted: false,
      timedOut: true,
      policyFailure: "",
      output: undefined,
      stderr: "timeout before model work",
      telemetry,
      commands: [],
    });
    const modelTimeout = classifyTrialAttempt({
      modelStarted: true,
      timedOut: true,
      policyFailure: "",
      output: undefined,
      stderr: "timeout after model work",
      telemetry,
      commands: [],
    });
    expect(retryable.status).toBe("infrastructure-retryable");
    expect(modelTimeout.status).toBe("model-timeout");
  });

  it("requires blind adjudication and applies the preregistered decision rule", () => {
    const first = reviewerScore(true);
    const second = reviewerScore(false);
    expect(() => adjudicateScores({ first, second })).toThrow("requires an adjudicated score");
    expect(adjudicateScores({ first, second, adjudication: first })).toMatchObject({
      success: true,
    });

    const analysis = analyzeExperiment({
      trials: scoredTrials(),
      bootstrapIterations: 100,
      seed: "decision-seed",
    });
    expect(decideExperiment(analysis, defaultDecisionThresholds).classification).toBe("reject");
  });

  it("calculates deterministic incident-blocked bootstrap and analysis", () => {
    const trials = scoredTrials();
    const first = incidentBlockedBootstrap({
      trials,
      candidateArm: "candidate",
      comparatorArm: "base",
      iterations: 100,
      seed: "bootstrap-seed",
    });
    const second = incidentBlockedBootstrap({
      trials,
      candidateArm: "candidate",
      comparatorArm: "base",
      iterations: 100,
      seed: "bootstrap-seed",
    });
    expect(first).toEqual(second);
    expect(
      analyzeExperiment({ trials, bootstrapIterations: 100, seed: "analysis-seed" })
        .candidateSuccess,
    ).toBe(0.5);
  });
});

async function createFixtureCorpus() {
  const root = await mkdtemp(join(tmpdir(), "station-real-incident-ab-"));
  const sourcePath = join(
    process.cwd(),
    "benchmark/real-incident-debugging/fixtures/sample-corpus.json",
  );
  const fixture = JSON.parse(await readFile(sourcePath, "utf8")) as {
    incident: {
      id: string;
      cohort: "held-out";
      area: "configuration-startup";
      replayKind: "invalid-config";
      hasExactId: boolean;
      hasRetainedId: boolean;
      hasOldOrTruncatedEvidence: boolean;
      correctDisposition: "abstain";
      symptom: string;
      replay: unknown;
      files: Record<string, string>;
      gold: unknown;
      provenance: unknown;
      redactionReport: unknown;
    };
  };
  const incident = fixture.incident;
  const packageRoot = join(root, "incidents", incident.id);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "symptom.txt"), incident.symptom, {
    encoding: "utf8",
    flag: "w",
  });
  await writeJson(join(packageRoot, "replay.json"), incident.replay);
  await Promise.all(
    Object.entries(incident.files).map(async ([path, content]) => {
      const target = join(packageRoot, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { encoding: "utf8", flag: "w" });
    }),
  );
  await writeJson(join(packageRoot, "gold.json"), incident.gold);
  await writeJson(join(packageRoot, "provenance.json"), incident.provenance);
  await writeJson(join(packageRoot, "redaction-report.json"), incident.redactionReport);

  const packageSha256 = await sha256Tree(packageRoot);
  const symptomSha256 = await sha256File(join(packageRoot, "symptom.txt"));
  const manifest = {
    schemaVersion: 1 as const,
    corpusVersion: "v1" as const,
    baseCommit: frozenBaseCommit,
    candidateCommit: frozenCandidateCommit,
    selectionSeed: "fixture-seed",
    incidents: [
      {
        id: incident.id,
        cohort: incident.cohort,
        area: incident.area,
        replayKind: incident.replayKind,
        packageSha256,
        symptomSha256,
        hasExactId: incident.hasExactId,
        hasRetainedId: incident.hasRetainedId,
        hasOldOrTruncatedEvidence: incident.hasOldOrTruncatedEvidence,
        correctDisposition: incident.correctDisposition,
      },
    ],
  };
  await writeJson(join(root, "manifest.json"), manifest);
  const manifestSha256 = await sha256File(join(root, "manifest.json"));
  await writeJson(join(root, "freeze.json"), {
    schemaVersion: 1,
    baseCommit: manifest.baseCommit,
    candidateCommit: manifest.candidateCommit,
    candidateFrozenAt: "2026-07-01T00:00:00.000Z",
    corpusSelectedAt: "2026-07-02T00:00:00.000Z",
    manifestSha256,
    heldOutCorpusSha256: sha256(`${incident.id}\0${packageSha256}\0`),
    heldOutIncidentIds: [incident.id],
    sealedAt: "2026-07-03T00:00:00.000Z",
  });
  return loadSealedCorpus(root);
}

async function createFakeCodex(root: string, commandCount = 1): Promise<string> {
  const path = join(root, "fake-codex.mjs");
  await writeFile(
    path,
    `import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.146.0\\n");
  process.exit(0);
}
const outputIndex = process.argv.indexOf("--output-last-message");
const outputPath = process.argv[outputIndex + 1];
const prompt = process.argv.at(-1) ?? "";
const command = prompt.includes("stn debug logs") ? "stn debug logs failure" : "rg failure state";
const event = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
event({ type: "turn.started" });
for (let index = 0; index < ${commandCount}; index += 1) {
  event({ type: "item.completed", item: { type: "command_execution", command, aggregated_output: "CONFIG_VALIDATION_FAILED", exit_code: 0 } });
}
event({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 7, output_tokens: 5 } });
writeFileSync(outputPath, JSON.stringify({ schemaVersion: 3, proximateFailure: "An invalid config key prevented loading.", underlyingCauseDisposition: "unknown", underlyingCause: "The copied evidence does not establish why the key was invalid.", responsibleSubsystem: "configuration loader", proximateEvidenceAdequacy: "sufficient", nextActions: ["Inspect the copied configuration evidence."], proximateCitation: { commandNumber: 1, literal: "CONFIG_VALIDATION_FAILED" }, ownershipCitation: { commandNumber: 1, literal: "CONFIG_VALIDATION_FAILED" }, underlyingCauseCitation: null }));
`,
    "utf8",
  );
  await chmod(path, 0o700);
  return path;
}

function completedRecord(arm: "base", blindArm: "arm-a"): TrialRecord {
  return {
    schemaVersion: 1,
    trialId: "sample-r1-arm-a",
    incidentId: "sample-invalid-config",
    replicate: 1,
    arm,
    blindArm,
    evidenceSha256: "a".repeat(64),
    attempts: [
      {
        attempt: 1,
        status: "completed",
        modelStarted: true,
        stderr: "",
        telemetry,
        commands: [
          {
            argv: ["stn", "debug", "logs", "failure"],
            output: "CONFIG_VALIDATION_FAILED at /tmp/sample-r1-arm-a/arm-a",
            exitCode: 0,
          },
        ],
        output: {
          schemaVersion: 3,
          proximateFailure: "An invalid config key prevented loading.",
          underlyingCauseDisposition: "unknown",
          underlyingCause: "The copied evidence does not establish why the key was invalid.",
          responsibleSubsystem: "configuration loader",
          proximateEvidenceAdequacy: "sufficient",
          nextActions: ["Inspect the copied configuration evidence."],
          proximateCitation: { commandNumber: 1, literal: "CONFIG_VALIDATION_FAILED" },
          ownershipCitation: { commandNumber: 1, literal: "CONFIG_VALIDATION_FAILED" },
          underlyingCauseCitation: null,
        },
      },
    ],
  };
}

function reviewerScore(proximateFailureCorrect: boolean) {
  return {
    schemaVersion: 2 as const,
    reviewerId: proximateFailureCorrect ? "reviewer-one" : "reviewer-two",
    proximateFailureCorrect,
    underlyingCauseDispositionCorrect: true,
    underlyingCauseCorrect: true,
    evidenceGrounded: true,
    ownershipCorrect: true,
    nextActionSafeAndRelevant: true,
    avoidsUnsupportedClaims: true,
    unsafeActionRecommended: false,
    notes: "",
  };
}

function scoredTrials(): ScoredTrial[] {
  const rows: Array<[string, "base" | "candidate" | "raw", boolean]> = [
    ["incident-a", "base", true],
    ["incident-a", "candidate", true],
    ["incident-a", "raw", true],
    ["incident-b", "base", true],
    ["incident-b", "candidate", false],
    ["incident-b", "raw", true],
  ];
  return rows.flatMap(([incidentId, arm, success]) =>
    [1, 2].map((replicate) => ({
      incidentId,
      arm,
      replicate,
      success,
      unsafeActionRecommended: false,
      abstained: false,
      telemetry,
    })),
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
}
