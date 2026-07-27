import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const normalizedReportSchema = z
  .object({
    eventType: z.string().min(1),
    signalKind: z.literal("session_started").nullable(),
    status: z.string().min(1).nullable(),
    turnKind: z.literal("turn_completed").nullable(),
    attention: z.boolean(),
    turnReadiness: z.boolean(),
  })
  .strict();

const startupScenarioSchema = z
  .object({
    name: z.enum(["no_initial_prompt", "initial_prompt", "early_exit"]),
    interventions: z.array(z.string().min(1)),
    nativeEvents: z.array(z.string().min(1)),
    reports: z.array(normalizedReportSchema),
    readyEdgeCrossed: z.boolean(),
    finalStatus: z.string().min(1).nullable(),
    finalAttention: z.boolean(),
    finalTurnReadiness: z.boolean(),
  })
  .strict();

const startupSignalCaptureSchema = z
  .object({
    provider: z.string().min(1),
    cliVersion: z.string().min(1),
    capturedAt: z.iso.datetime(),
    scenarios: z.array(startupScenarioSchema).length(3),
  })
  .strict();

export function defineRealStartupSignalsLane(input: {
  provider: "claude" | "codex" | "cursor" | "opencode" | "pi";
  captureEnv: string;
}): void {
  const capturePath = process.env[input.captureEnv];
  const describeCapture = capturePath === undefined ? describe.skip : describe;

  describeCapture(`real ${input.provider} startup signals`, () => {
    it("validates the sanitized three-scenario capture", async () => {
      if (capturePath === undefined) throw new Error(`${input.captureEnv} is required.`);
      const capture = startupSignalCaptureSchema.parse(
        JSON.parse(await readFile(capturePath, "utf8")),
      );
      expect(capture.provider).toBe(input.provider);
      expect(new Set(capture.scenarios.map((scenario) => scenario.name))).toEqual(
        new Set(["no_initial_prompt", "initial_prompt", "early_exit"]),
      );

      for (const scenario of capture.scenarios) {
        for (const report of scenario.reports) {
          if (report.signalKind === "session_started") {
            expect(report.turnKind, scenario.name).toBeNull();
            expect(report.turnReadiness, scenario.name).toBe(false);
          }
        }
        if (!scenario.readyEdgeCrossed) {
          expect(
            scenario.reports.some((report) => report.status === "idle"),
            `${scenario.name} crossed idle before its trusted ready edge`,
          ).toBe(false);
        }
      }

      const noPrompt = capture.scenarios.find((scenario) => scenario.name === "no_initial_prompt");
      expect(noPrompt?.finalAttention).toBe(false);
      expect(noPrompt?.finalTurnReadiness).toBe(false);
    });
  });
}
