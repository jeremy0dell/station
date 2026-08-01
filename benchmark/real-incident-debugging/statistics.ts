import type { Arm, DecisionThresholds, TrialTelemetry } from "./protocol.js";

export type ScoredTrial = {
  incidentId: string;
  arm: Arm;
  replicate: number;
  success: boolean;
  unsafeActionRecommended: boolean;
  abstained: boolean;
  telemetry: TrialTelemetry;
};

export type BootstrapEffect = {
  pointEstimate: number;
  lower95: number;
  upper95: number;
};

export type IncidentComparison = {
  wins: string[];
  ties: string[];
  losses: string[];
  severeLosses: string[];
};

export type ExperimentAnalysis = {
  candidateSuccess: number;
  candidateMinusBase: BootstrapEffect;
  candidateMinusRaw: BootstrapEffect;
  efficiencyRatios: Record<keyof TrialTelemetry, number>;
  versusBase: IncidentComparison;
  versusRaw: IncidentComparison;
  candidateAbstentionRate: number;
  candidateUnsafeActionRate: number;
};

export type ExperimentDecision = {
  classification: "ship" | "redesign" | "reject";
  reasons: string[];
};

export function incidentBlockedBootstrap(input: {
  trials: ScoredTrial[];
  candidateArm: Arm;
  comparatorArm: Arm;
  iterations: number;
  seed: string;
}): BootstrapEffect {
  assertCompletePairedArms(input.trials, [input.candidateArm, input.comparatorArm]);
  if (input.iterations < 20) {
    throw new Error("Blocked bootstrap requires at least 20 iterations.");
  }
  const incidentIds = [...new Set(input.trials.map((trial) => trial.incidentId))].sort();
  const byIncident = trialsByIncident(input.trials);
  const effectFor = (sample: string[]): number => {
    const candidate = mean(
      sample.flatMap(
        (id) => byIncident.get(id)?.filter((trial) => trial.arm === input.candidateArm) ?? [],
      ),
      (trial) => Number(trial.success),
    );
    const comparator = mean(
      sample.flatMap(
        (id) => byIncident.get(id)?.filter((trial) => trial.arm === input.comparatorArm) ?? [],
      ),
      (trial) => Number(trial.success),
    );
    return candidate - comparator;
  };
  const random = seededRandom(input.seed);
  const effects: number[] = [];
  for (let index = 0; index < input.iterations; index += 1) {
    const sample = incidentIds.map(
      () => incidentIds[Math.floor(random() * incidentIds.length)] ?? "",
    );
    effects.push(effectFor(sample));
  }
  effects.sort((left, right) => left - right);
  return {
    pointEstimate: effectFor(incidentIds),
    lower95: percentile(effects, 0.025),
    upper95: percentile(effects, 0.975),
  };
}

export function analyzeExperiment(input: {
  trials: ScoredTrial[];
  bootstrapIterations: number;
  seed: string;
}): ExperimentAnalysis {
  assertCompletePairedArms(input.trials, ["base", "candidate", "raw"]);
  const candidateTrials = input.trials.filter((trial) => trial.arm === "candidate");
  return {
    candidateSuccess: mean(candidateTrials, (trial) => Number(trial.success)),
    candidateMinusBase: incidentBlockedBootstrap({
      trials: input.trials,
      candidateArm: "candidate",
      comparatorArm: "base",
      iterations: input.bootstrapIterations,
      seed: `${input.seed}:base`,
    }),
    candidateMinusRaw: incidentBlockedBootstrap({
      trials: input.trials,
      candidateArm: "candidate",
      comparatorArm: "raw",
      iterations: input.bootstrapIterations,
      seed: `${input.seed}:raw`,
    }),
    efficiencyRatios: telemetryRatios(input.trials, "candidate", "base"),
    versusBase: compareIncidents(input.trials, "candidate", "base"),
    versusRaw: compareIncidents(input.trials, "candidate", "raw"),
    candidateAbstentionRate: mean(candidateTrials, (trial) => Number(trial.abstained)),
    candidateUnsafeActionRate: mean(candidateTrials, (trial) =>
      Number(trial.unsafeActionRecommended),
    ),
  };
}

export function decideExperiment(
  analysis: ExperimentAnalysis,
  thresholds: DecisionThresholds,
): ExperimentDecision {
  const decisionEfficiencyMetrics: Array<keyof TrialTelemetry> = [
    "wallTimeMs",
    "commandCount",
    "modelCycles",
    "totalTokens",
  ];
  const noMaterialEfficiencyRegression = decisionEfficiencyMetrics.every(
    (metric) => analysis.efficiencyRatios[metric] <= thresholds.maxEfficiencyRatio,
  );
  const severeBaseLosses = analysis.versusBase.severeLosses.length;
  const noninferiorToBase = analysis.candidateMinusBase.lower95 >= thresholds.noninferiorityMargin;
  const notWorseThanRaw = analysis.candidateMinusRaw.pointEstimate >= thresholds.rawEvidenceMargin;
  const unsafe = analysis.candidateUnsafeActionRate > 0;
  const ship =
    analysis.candidateSuccess >= thresholds.candidateSuccessMinimum &&
    noninferiorToBase &&
    !unsafe &&
    severeBaseLosses <= thresholds.maxBothCandidateFailBaseSucceed &&
    notWorseThanRaw &&
    noMaterialEfficiencyRegression;
  if (ship) {
    return {
      classification: "ship",
      reasons: ["Candidate meets the preregistered correctness and safety thresholds."],
    };
  }

  if (!noninferiorToBase || !notWorseThanRaw || unsafe) {
    const reasons: string[] = [];
    if (!noninferiorToBase) {
      reasons.push("Candidate is inferior to base beyond the noninferiority margin.");
    }
    if (!notWorseThanRaw) {
      reasons.push("Candidate is more than the allowed margin worse than raw evidence.");
    }
    if (unsafe) {
      reasons.push("Candidate recommended an unsafe action.");
    }
    return { classification: "reject", reasons };
  }

  const consistentLosses = analysis.versusBase.losses.length;
  const evidenceGap = analysis.versusBase.severeLosses.length > 0;
  const reasons: string[] = [];
  if (analysis.candidateSuccess < thresholds.candidateSuccessMinimum) {
    reasons.push("Candidate did not reach the required success rate.");
  }
  if (consistentLosses >= 2) {
    reasons.push("Candidate has consistent incident-level losses versus base.");
  }
  if (evidenceGap) {
    reasons.push("Candidate has an incident-level evidence-availability gap.");
  }
  if (severeBaseLosses > thresholds.maxBothCandidateFailBaseSucceed) {
    reasons.push(
      "Too many incidents have both candidate replicates fail while base replicates succeed.",
    );
  }
  if (!noMaterialEfficiencyRegression) {
    reasons.push("Candidate has a material efficiency regression.");
  }
  return { classification: "redesign", reasons };
}

export function compareIncidents(
  trials: ScoredTrial[],
  candidateArm: Arm,
  comparatorArm: Arm,
): IncidentComparison {
  assertCompletePairedArms(trials, [candidateArm, comparatorArm]);
  const wins: string[] = [];
  const ties: string[] = [];
  const losses: string[] = [];
  const severeLosses: string[] = [];
  for (const [incidentId, incidentTrials] of trialsByIncident(trials)) {
    const candidate = incidentTrials.filter((trial) => trial.arm === candidateArm);
    const comparator = incidentTrials.filter((trial) => trial.arm === comparatorArm);
    const candidateScore = mean(candidate, (trial) => Number(trial.success));
    const comparatorScore = mean(comparator, (trial) => Number(trial.success));
    if (candidateScore > comparatorScore) {
      wins.push(incidentId);
    } else if (candidateScore < comparatorScore) {
      losses.push(incidentId);
      if (
        candidate.every((trial) => !trial.success) &&
        comparator.every((trial) => trial.success)
      ) {
        severeLosses.push(incidentId);
      }
    } else {
      ties.push(incidentId);
    }
  }
  return {
    wins: wins.sort(),
    ties: ties.sort(),
    losses: losses.sort(),
    severeLosses: severeLosses.sort(),
  };
}

function telemetryRatios(
  trials: ScoredTrial[],
  numeratorArm: Arm,
  denominatorArm: Arm,
): Record<keyof TrialTelemetry, number> {
  const numerator = sumTelemetry(trials.filter((trial) => trial.arm === numeratorArm));
  const denominator = sumTelemetry(trials.filter((trial) => trial.arm === denominatorArm));
  return {
    wallTimeMs: ratio(numerator.wallTimeMs, denominator.wallTimeMs),
    commandCount: ratio(numerator.commandCount, denominator.commandCount),
    modelCycles: ratio(numerator.modelCycles, denominator.modelCycles),
    totalTokens: ratio(numerator.totalTokens, denominator.totalTokens),
    outputBytes: ratio(numerator.outputBytes, denominator.outputBytes),
  };
}

function sumTelemetry(trials: ScoredTrial[]): TrialTelemetry {
  return trials.reduce<TrialTelemetry>(
    (total, trial) => ({
      wallTimeMs: total.wallTimeMs + trial.telemetry.wallTimeMs,
      commandCount: total.commandCount + trial.telemetry.commandCount,
      modelCycles: total.modelCycles + trial.telemetry.modelCycles,
      totalTokens: total.totalTokens + trial.telemetry.totalTokens,
      outputBytes: total.outputBytes + trial.telemetry.outputBytes,
    }),
    { wallTimeMs: 0, commandCount: 0, modelCycles: 0, totalTokens: 0, outputBytes: 0 },
  );
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return numerator === 0 ? 1 : Number.POSITIVE_INFINITY;
  }
  return numerator / denominator;
}

function assertCompletePairedArms(trials: ScoredTrial[], arms: Arm[]): void {
  const byIncident = trialsByIncident(trials);
  for (const [incidentId, incidentTrials] of byIncident) {
    const replicateCounts = arms.map(
      (arm) => incidentTrials.filter((trial) => trial.arm === arm).length,
    );
    if (replicateCounts.some((count) => count === 0) || new Set(replicateCounts).size !== 1) {
      throw new Error(`Incomplete paired arm data for incident ${incidentId}.`);
    }
  }
}

function trialsByIncident(trials: ScoredTrial[]): Map<string, ScoredTrial[]> {
  const output = new Map<string, ScoredTrial[]>();
  for (const trial of trials) {
    const existing = output.get(trial.incidentId);
    if (existing === undefined) {
      output.set(trial.incidentId, [trial]);
    } else {
      existing.push(trial);
    }
  }
  return output;
}

function mean<T>(values: T[], value: (item: T) => number): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate a mean from no values.");
  }
  return values.reduce((total, item) => total + value(item), 0) / values.length;
}

function percentile(values: number[], fraction: number): number {
  const index = Math.floor((values.length - 1) * fraction);
  return values[index] ?? 0;
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
