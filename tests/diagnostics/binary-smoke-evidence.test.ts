import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function loadEvidenceModule() {
  return import("../../scripts/test-runners/binary-smoke-evidence.mjs");
}

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "station-evidence-test-"));
  temporaryRoots.push(parent);
  const smokeRoot = join(parent, "smoke");
  const stateDir = join(smokeRoot, "state");
  const evidenceDir = join(parent, "station-binary-smoke-evidence");
  await mkdir(join(stateDir, "logs"), { recursive: true, mode: 0o700 });
  return { parent, smokeRoot, stateDir, evidenceDir, socketPath: join(smokeRoot, "observer.sock") };
}

function artifact(path: string, marker: string) {
  return {
    path,
    displayVersion: "0.0.0-local",
    buildIdentity: marker.repeat(64),
  };
}

function captureInput(input: Awaited<ReturnType<typeof fixture>>) {
  return {
    evidenceDir: input.evidenceDir,
    smokeRoot: input.smokeRoot,
    stateDir: input.stateDir,
    socketPath: input.socketPath,
    status: "failed",
    round: 1,
    elapsedMs: 1842,
    direction: { logical: "lower-to-higher", physical: "current-to-alternate" },
    error: new Error(`handoff failed at ${input.smokeRoot} with API_TOKEN=super-secret-value`),
    failure: {
      command: {
        artifact: "alternate",
        argv: ["observer", "start", "--timeout-ms", "30000"],
      },
      exitDisposition: { type: "code", code: 1 },
    },
    artifacts: {
      current: artifact(join(input.smokeRoot, "station/dist/bin/stn"), "a"),
      alternate: artifact(join(input.smokeRoot, "alternate/stn"), "b"),
      incumbent: "current",
      requested: "alternate",
    },
    knownProcesses: [{ role: "incumbent", pid: process.pid }],
    now: new Date("2026-07-29T17:00:00.000Z"),
  } as const;
}

function logRecord(index: number): string {
  return JSON.stringify({
    timestamp: "2026-07-29T17:00:00.000Z",
    level: "error",
    component: "observer",
    message: `Observer handoff record ${index} trc_example`,
    traceId: "trc_example",
    attributes: {
      stage: "handoff",
      pid: 1234,
      providerData: { API_TOKEN: "must-not-survive" },
    },
  });
}

async function treeBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await treeBytes(child) : (await lstat(child)).size;
  }
  return total;
}

describe("binary smoke failure evidence", () => {
  it("writes bounded redacted evidence before cleanup and preserves it afterward", async () => {
    const input = await fixture();
    const module = await loadEvidenceModule();
    const bootLines = Array.from(
      { length: 140 },
      (_, index) => `${"x".repeat(700)} boot-${index} API_TOKEN=super-secret-value`,
    );
    const logLines = Array.from({ length: 240 }, (_, index) => logRecord(index));
    await writeFile(join(input.stateDir, "logs/observer-boot.log"), bootLines.join("\n"), {
      mode: 0o600,
    });
    await writeFile(join(input.stateDir, "logs/observer.jsonl"), logLines.join("\n"), {
      mode: 0o600,
    });
    await writeFile(join(input.stateDir, "logs/cli.jsonl"), `${logRecord(1)}\n`, { mode: 0o600 });
    await writeFile(
      `${input.socketPath}.pid`,
      JSON.stringify({
        pid: process.pid,
        osStartTime: "2026-07-29T16:59:00.000Z",
        processToken: randomUUID(),
        version: `0.0.0-local+station.${"a".repeat(64)}`,
        socketPath: input.socketPath,
      }),
      { mode: 0o600 },
    );

    const manifest = await module.captureBinarySmokeEvidence(captureInput(input));
    expect(module.BinarySmokeEvidenceManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.rounds[0].correlation.traceIds).toEqual(["trc_example"]);
    expect(manifest.rounds[0].runtime.pidfile).toMatchObject({
      status: "parsed",
      pid: process.pid,
      buildIdentity: "aaaaaaaaaaaa",
    });
    expect(manifest.redaction.replacements).toBeGreaterThan(0);
    expect(manifest.redaction.suspiciousSecretsFound).toBeGreaterThan(0);

    const roundDir = join(input.evidenceDir, "rounds/0001-current-to-alternate");
    const failure = await readFile(join(roundDir, "failure.json"), "utf8");
    const boot = await readFile(join(roundDir, "observer-boot.log"), "utf8");
    const observer = await readFile(join(roundDir, "logs/observer.jsonl"), "utf8");
    expect(failure).toContain("$SMOKE_ROOT");
    expect(failure).toContain("API_TOKEN=[REDACTED]");
    expect(failure).not.toContain(input.smokeRoot);
    expect(boot.split("\n").filter(Boolean).length).toBeLessThanOrEqual(100);
    expect(boot).toContain("boot-139");
    expect(boot).not.toContain("boot-0 ");
    expect(boot).not.toContain("super-secret-value");
    expect(observer.split("\n").filter(Boolean)).toHaveLength(200);
    expect(observer).not.toContain("providerData");
    expect(observer).not.toContain("must-not-survive");
    expect(Buffer.byteLength(boot)).toBeLessThanOrEqual(65_536);
    expect(Buffer.byteLength(observer)).toBeLessThanOrEqual(131_072);
    expect(await treeBytes(input.evidenceDir)).toBeLessThanOrEqual(1_048_576);
    expect((await lstat(input.evidenceDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(input.evidenceDir, "manifest.json"))).mode & 0o777).toBe(0o600);

    await rm(input.smokeRoot, { recursive: true, force: true });
    await module.finalizeBinarySmokeEvidence({
      evidenceDir: input.evidenceDir,
      cleanup: {
        status: "complete",
        observerExited: true,
        hostExited: true,
        socketRemoved: true,
        pidfileRemoved: true,
      },
      processes: [{ role: "incumbent", pid: process.pid, exists: true }],
      warnings: [],
    });
    const finalized = JSON.parse(await readFile(join(input.evidenceDir, "manifest.json"), "utf8"));
    expect(finalized.rounds[0].cleanup.status).toBe("complete");
    expect(await readdir(input.evidenceDir)).toEqual(["manifest.json", "rounds"]);
  }, 15_000);

  it("records symlink, malformed, and missing sources without following them", async () => {
    const input = await fixture();
    const module = await loadEvidenceModule();
    const outside = join(input.parent, "outside.log");
    await writeFile(outside, "API_TOKEN=outside-secret", { mode: 0o600 });
    await symlink(outside, join(input.stateDir, "logs/observer-boot.log"));
    await writeFile(join(input.stateDir, "logs/observer.jsonl"), "not-json\n", { mode: 0o600 });

    const manifest = await module.captureBinarySmokeEvidence(captureInput(input));
    expect(manifest.rounds[0].files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "state/logs/observer-boot.log",
          status: "refused_symlink",
        }),
        expect.objectContaining({ source: "state/logs/observer.jsonl", status: "malformed" }),
        expect.objectContaining({ source: "state/logs/cli.jsonl", status: "missing" }),
      ]),
    );
    expect(JSON.stringify(manifest)).not.toContain("outside-secret");
  });

  it("rejects unsafe destinations and creates no directory for an uncaptured success", async () => {
    const input = await fixture();
    const module = await loadEvidenceModule();
    await expect(
      module.captureBinarySmokeEvidence({
        ...captureInput(input),
        evidenceDir: "relative/evidence",
      }),
    ).rejects.toThrow("must be absolute");
    await expect(
      module.captureBinarySmokeEvidence({
        ...captureInput(input),
        evidenceDir: join(input.smokeRoot, "evidence"),
      }),
    ).rejects.toThrow("outside the smoke root");
    await expect(lstat(input.evidenceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
