import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../../../apps/cli/src/index.js";
import { createTempState, writeConfigToml } from "../../../support/temp-projects";

describe("CLI causal evidence projection", () => {
  it("separates operational failure evidence from log provenance", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    await mkdir(join(fixture.stateDir, "logs"), { recursive: true });
    await writeFile(
      join(fixture.stateDir, "logs", "cli.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-05-20T12:02:00.000Z",
        level: "error",
        component: "cli",
        message: "Observer lifecycle failed.",
        traceId: "trc_lifecycle",
        attributes: {
          operation: "cli.observer.start",
          error: {
            tag: "ObserverStartupError",
            code: "OBSERVER_START_FAILED",
            message: "Observer did not become healthy before the startup timeout.",
          },
        },
      })}\n`,
    );

    const result = await runCli(["--config", configPath, "debug", "trace", "--latest-failure"], {
      observerDeps: {
        clientFactory: () => {
          throw new Error("debug trace must remain local");
        },
      },
    });

    expect(result).toMatchObject({
      code: 0,
      output: {
        causeAssessment: {
          status: "observed_failure",
          explicitRootCauseCodes: [],
          observedFailureCodes: ["OBSERVER_START_FAILED"],
        },
        evidenceRoles: {
          operationalBoundaryEvidence: "failure_and_ownership_evidence",
          component: "logging_location_only",
        },
        operationalBoundaryEvidence: {
          operation: "cli.observer.start",
          recordSummary: "Observer lifecycle failed.",
          errorCode: "OBSERVER_START_FAILED",
          errorMessage: "Observer did not become healthy before the startup timeout.",
        },
      },
    });
    expect(result.output).not.toHaveProperty("reportedBy");
  });

  it("retains bounded citation context for a queried log record", async () => {
    const fixture = await createTempState();
    const configPath = await writeConfigToml(fixture.root, fixture.config);
    await mkdir(join(fixture.stateDir, "logs"), { recursive: true });
    await writeFile(
      join(fixture.stateDir, "logs", "observer.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-05-20T12:03:00.000Z",
        level: "warn",
        component: "observer",
        message: "Local Git ref resolution failed.",
        attributes: {
          operation: "metadata.localGit.resolveRef",
          error: {
            tag: "LocalGitError",
            code: "LOCAL_GIT_REF_UNRESOLVED",
            message: "Git ref could not be resolved.",
          },
        },
      })}\n`,
    );

    const result = await runCli(
      ["--config", configPath, "debug", "logs", "LOCAL_GIT_REF_UNRESOLVED"],
      {
        observerDeps: {
          clientFactory: () => {
            throw new Error("debug logs must remain local");
          },
        },
      },
    );

    expect(result).toMatchObject({
      code: 0,
      output: {
        causeAssessment: {
          status: "observed_failure",
          observedFailureCodes: ["LOCAL_GIT_REF_UNRESOLVED"],
        },
        records: [
          {
            component: "observer",
            componentRole: "logging_location",
            operationalBoundaryEvidence: {
              operation: "metadata.localGit.resolveRef",
              recordSummary: "Local Git ref resolution failed.",
              errorCode: "LOCAL_GIT_REF_UNRESOLVED",
              errorMessage: "Git ref could not be resolved.",
            },
            matchEvidence: [
              {
                path: "/attributes/error/code",
                excerpt: "LOCAL_GIT_REF_UNRESOLVED",
              },
            ],
          },
        ],
      },
    });
  });
});
