import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertStudyComposition, loadSealedCorpus } from "./corpus.js";
import {
  createCodexExecutor,
  generateBlindReviewPackets,
  preflightCorpus,
  runExperiment,
} from "./harness.js";
import { experimentTokenBudget } from "./protocol.js";

const enabled = process.env.STATION_REAL_INCIDENT_DEBUG_AB === "1";
const phase = process.env.STATION_REAL_INCIDENT_DEBUG_AB_PHASE ?? "run";
const corpusRoot = process.env.STATION_REAL_INCIDENT_DEBUG_AB_CORPUS;
const artifactsRoot = process.env.STATION_REAL_INCIDENT_DEBUG_AB_ARTIFACTS;

const describeReal = enabled ? describe : describe.skip;

describeReal("real-incident Codex high debugging A/B", () => {
  it("runs only an explicitly enabled sealed phase", async () => {
    expect(
      corpusRoot,
      "Set STATION_REAL_INCIDENT_DEBUG_AB_CORPUS to the private sealed corpus.",
    ).toBeDefined();
    expect(
      artifactsRoot,
      "Set STATION_REAL_INCIDENT_DEBUG_AB_ARTIFACTS to an empty private artifact root.",
    ).toBeDefined();
    if (corpusRoot === undefined || artifactsRoot === undefined) {
      return;
    }

    expect(["preflight", "development", "held-out"]).toContain(phase);
    if (phase !== "preflight" && phase !== "development" && phase !== "held-out") {
      return;
    }
    const corpus = await loadSealedCorpus(corpusRoot);
    assertStudyComposition(corpus);
    const stationExecutables = stationExecutablesFromEnvironment({
      base: corpus.manifest.baseCommit,
      candidate: corpus.manifest.candidateCommit,
    });

    if (phase === "preflight") {
      const fakeCodex = process.env.STATION_REAL_INCIDENT_DEBUG_AB_FAKE_CODEX;
      expect(
        fakeCodex,
        "Preflight requires STATION_REAL_INCIDENT_DEBUG_AB_FAKE_CODEX.",
      ).toBeDefined();
      if (fakeCodex === undefined) {
        return;
      }
      await preflightCorpus({
        corpus,
        workspaceRoot: join(artifactsRoot, "preflight-workspaces"),
        stationExecutables,
      });
      const run = await runExperiment({
        corpus,
        artifactRoot: join(artifactsRoot, "preflight"),
        replicates: 1,
        seed: corpus.manifest.selectionSeed,
        stationExecutables,
        executor: createCodexExecutor({
          executable: fakeCodex,
          timeoutMs: 30_000,
          tokenBudget: experimentTokenBudget,
        }),
      });
      await generateBlindReviewPackets({ paths: run.paths, corpus, state: run.state });
      return;
    }

    expect(process.env.STATION_REAL_INCIDENT_DEBUG_AB_RUN_PAID).toBe("1");
    const codex = process.env.STATION_REAL_INCIDENT_DEBUG_AB_CODEX;
    const codexVersion = process.env.STATION_REAL_INCIDENT_DEBUG_AB_CODEX_VERSION;
    const codexAuth = process.env.STATION_REAL_INCIDENT_DEBUG_AB_CODEX_AUTH;
    expect(
      codex,
      "Set STATION_REAL_INCIDENT_DEBUG_AB_CODEX to the pinned Codex CLI.",
    ).toBeDefined();
    expect(
      codexVersion,
      "Set STATION_REAL_INCIDENT_DEBUG_AB_CODEX_VERSION to the pinned Codex CLI version.",
    ).toBeDefined();
    expect(
      codexAuth,
      "Set STATION_REAL_INCIDENT_DEBUG_AB_CODEX_AUTH to an auth.json copied only into ephemeral homes.",
    ).toBeDefined();
    if (codex === undefined || codexVersion === undefined || codexAuth === undefined) {
      return;
    }
    const selected =
      phase === "development"
        ? corpus.incidents.filter((incident) => incident.entry.cohort === "development")
        : corpus.incidents.filter((incident) => incident.entry.cohort === "held-out");
    const replicates = phase === "development" ? 1 : 2;
    const selectedCorpus = { ...corpus, incidents: selected };
    const run = await runExperiment({
      corpus: selectedCorpus,
      artifactRoot: join(artifactsRoot, phase),
      replicates,
      seed: corpus.manifest.selectionSeed,
      stationExecutables,
      executor: createCodexExecutor({
        executable: codex,
        expectedVersion: codexVersion,
        authFilePath: codexAuth,
        timeoutMs: 300_000,
        tokenBudget: experimentTokenBudget,
      }),
    });
    await generateBlindReviewPackets({
      paths: run.paths,
      corpus: selectedCorpus,
      state: run.state,
    });
  });
});

function stationExecutablesFromEnvironment(input: {
  base: string;
  candidate: string;
}): Record<"base" | "candidate", { path: string; commit: string }> {
  const base = process.env.STATION_REAL_INCIDENT_DEBUG_AB_BASE_STN;
  const candidate = process.env.STATION_REAL_INCIDENT_DEBUG_AB_CANDIDATE_STN;
  const baseCommit = process.env.STATION_REAL_INCIDENT_DEBUG_AB_BASE_COMMIT;
  const candidateCommit = process.env.STATION_REAL_INCIDENT_DEBUG_AB_CANDIDATE_COMMIT;
  if (
    base === undefined ||
    candidate === undefined ||
    baseCommit !== input.base ||
    candidateCommit !== input.candidate
  ) {
    throw new Error(
      "Set frozen Station executable paths and matching STATION_REAL_INCIDENT_DEBUG_AB_BASE_COMMIT/CANDIDATE_COMMIT values.",
    );
  }
  return {
    base: { path: base, commit: baseCommit },
    candidate: { path: candidate, commit: candidateCommit },
  };
}
