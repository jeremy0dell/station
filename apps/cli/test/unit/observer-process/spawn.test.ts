import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ObserverStartupFailureReportSchema, type SafeError } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { createTempState } from "../../../../../tests/support/temp-projects";
import {
  OBSERVER_STARTUP_FAILURE_FD,
  STATION_OBSERVER_STARTUP_FAILURE_FD,
} from "../../../src/observerProcess/failureReport.js";
import {
  defaultSpawnObserver,
  observerSpawnArgv,
  observerSpawnEnvironment,
} from "../../../src/observerProcess/spawn.js";
import { selfExecArgv } from "../../../src/selfExec.js";

const paths = {
  socketPath: "/tmp/station/run/observer.sock",
  stateDir: "/tmp/station",
  dbPath: "/tmp/station/observer.sqlite",
  logDir: "/tmp/station/logs",
  diagnosticsDir: "/tmp/station/diagnostics",
  hookSpoolDir: "/tmp/station/spool/hooks",
};
const buildVersion = `1.2.3+station.${"a".repeat(64)}`;
const processToken = ["a47ac10b", "58cc", "4372", "a567", "0e02b2c3d479"].join("-");
const unknownStartupError: SafeError = {
  tag: "ObserverStartupCauseError",
  code: "OBSERVER_STARTUP_CAUSE_UNKNOWN",
  message: "Observer startup failed for an unknown reason.",
};

describe("observer spawn argv", () => {
  it("keeps the source entry prefix and observer flag order", () => {
    const observerEntry = fileURLToPath(new URL("../../../dist/observerMain.js", import.meta.url));

    expect(
      observerSpawnArgv({ paths, startupTimeoutMs: 4321, buildVersion, processToken }),
    ).toEqual([
      process.execPath,
      observerEntry,
      "--socket",
      paths.socketPath,
      "--state-dir",
      paths.stateDir,
      "--startup-timeout-ms",
      "4321",
      "--build-version",
      buildVersion,
      "--process-token",
      processToken,
    ]);
    expect(
      observerSpawnArgv({
        paths,
        configPath: "/tmp/station/config.toml",
        startupTimeoutMs: 9876,
        buildVersion,
        processToken,
      }),
    ).toEqual([
      process.execPath,
      observerEntry,
      "--socket",
      paths.socketPath,
      "--state-dir",
      paths.stateDir,
      "--config",
      "/tmp/station/config.toml",
      "--startup-timeout-ms",
      "9876",
      "--build-version",
      buildVersion,
      "--process-token",
      processToken,
    ]);
  });

  it("maps the compiled observer prefix without claiming compiled spawn coverage", () => {
    expect(
      selfExecArgv("observer", ["node", "observerMain.js"], {
        compiled: true,
        execPath: "/opt/station/stn",
      }),
    ).toEqual(["/opt/station/stn", "__observer"]);
  });

  it("keeps generic startup fail-closed and opts only exact activation into preservation", () => {
    const inherited = {
      PATH: "/usr/bin",
      STATION_OBSERVER_STARTUP_POLICY: "preserve-incumbent",
      [STATION_OBSERVER_STARTUP_FAILURE_FD]: "99",
    };

    expect(observerSpawnEnvironment({}, inherited)).toEqual({
      PATH: "/usr/bin",
      [STATION_OBSERVER_STARTUP_FAILURE_FD]: String(OBSERVER_STARTUP_FAILURE_FD),
    });
    expect(observerSpawnEnvironment({ incumbentPolicy: "preserve" }, inherited)).toEqual({
      PATH: "/usr/bin",
      STATION_OBSERVER_STARTUP_POLICY: "preserve-incumbent",
      [STATION_OBSERVER_STARTUP_FAILURE_FD]: String(OBSERVER_STARTUP_FAILURE_FD),
    });
  });

  it("keeps real Worktrunk hook auto-start on the CLI observer entry", async () => {
    const source = await readFile(
      resolve(process.cwd(), "tests/e2e/real/real-worktrunk-hooks.test.ts"),
      "utf8",
    );

    expect(source).toContain('join(env.repoRoot, "apps", "cli", "dist", "observerMain.js")');
  });

  it.each([
    {
      label: "Error",
      fixture: "error",
      expectedError: {
        tag: "ObserverStartupCauseError",
        code: "OBSERVER_STARTUP_CAUSE_ERROR",
        message: "ordinary failure with API_TOKEN=[REDACTED]",
      } satisfies SafeError,
    },
    {
      label: "typed error",
      fixture: "typed",
      expectedError: {
        tag: "ObserverProcessEvidenceError",
        code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
        message: "Typed failure with API_TOKEN=[REDACTED]",
        hint: "Inspect the exact process evidence.",
      } satisfies SafeError,
    },
    {
      label: "plain object",
      fixture: "plain-object",
      expectedError: unknownStartupError,
    },
    {
      label: "unknown primitive",
      fixture: "unknown",
      expectedError: unknownStartupError,
    },
  ])("reports a real child process $label failure through the strict inherited pipe", async ({
    fixture: failureFixture,
    expectedError,
  }) => {
    const fixture = await createTempState();
    const childEntry = fileURLToPath(
      new URL("../../fixtures/observer-startup-failure-child.mjs", import.meta.url),
    );
    let child: Awaited<ReturnType<typeof defaultSpawnObserver>> | undefined;
    try {
      child = await defaultSpawnObserver({
        paths: fixture,
        startupTimeoutMs: 500,
        buildVersion,
        processToken,
        observerCommand: [process.execPath, childEntry, failureFixture, "--"],
      });

      const exit = await child.exited;
      expect(exit).toMatchObject({ type: "exit", code: 1, signal: null });
      if (exit?.report === undefined) throw new Error("Child failure report was absent.");
      expect(ObserverStartupFailureReportSchema.parse(exit.report)).toEqual({
        kind: "observer-startup-failure",
        version: 1,
        error: expectedError,
      });

      const bootLogTail = await child.readBootLogTail?.();
      expect(bootLogTail).toBeDefined();
      const [, ...stderrLines] = bootLogTail?.split("\n") ?? [];
      expect(stderrLines).toEqual([`${expectedError.message} (${expectedError.code})`]);

      const serializedEvidence = JSON.stringify({ report: exit.report, stderrLines });
      expect(serializedEvidence).not.toContain("super-secret-value");
      expect(serializedEvidence).not.toContain("/private/");
      expect(serializedEvidence).not.toContain("    at ");
    } finally {
      child?.disposeFailureReport?.();
      await child?.disposeBootLog?.();
      child?.kill?.();
      await fixture.cleanup();
    }
  });

  it.each([
    { label: "malformed", payloadExpression: JSON.stringify("not-json") },
    { label: "partial", payloadExpression: JSON.stringify('{"kind":') },
    { label: "multiple", payloadExpression: JSON.stringify("{}{}") },
    {
      label: "oversized",
      payloadExpression: `"x".repeat(${64 * 1024 + 1})`,
    },
  ])("handles a delayed child exit after $label report input", async ({ payloadExpression }) => {
    const fixture = await createTempState();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    let child: Awaited<ReturnType<typeof defaultSpawnObserver>> | undefined;
    try {
      const script = [
        'const { closeSync, writeSync } = require("node:fs");',
        `writeSync(3, Buffer.from(${payloadExpression}));`,
        "closeSync(3);",
        "setTimeout(() => process.exit(1), 25);",
      ].join("");
      child = await defaultSpawnObserver({
        paths: fixture,
        startupTimeoutMs: 500,
        buildVersion,
        processToken,
        observerCommand: [process.execPath, "-e", script, "--"],
      });

      await expect(child.exited).resolves.toMatchObject({ type: "exit", code: 1 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      child?.disposeFailureReport?.();
      await child?.disposeBootLog?.();
      child?.kill?.();
    }
  });
});
