import { readdirSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  reportTerminalCorruption,
  resetTerminalDiagnosticsForTest,
  terminalCorruptionCounters,
  wireTerminalDiagnostics,
  writePaneEvidenceDump,
} from "./diagnostics.js";

type LoggedRecord = { message: string; attributes: Record<string, unknown> };
const logged: LoggedRecord[] = [];
const fakeLogger = {
  path: "/tmp/fake-tui.jsonl",
  log: async () => ({}) as never,
  debug: async () => ({}) as never,
  info: async () => ({}) as never,
  warn: async (message: string, attributes?: Record<string, unknown>) => {
    logged.push({ message, attributes: attributes ?? {} });
    return {} as never;
  },
  error: async () => ({}) as never,
};

let dumpDir: string;
beforeEach(async () => {
  resetTerminalDiagnosticsForTest();
  logged.length = 0;
  dumpDir = await mkdtemp(join(tmpdir(), "station-diag-"));
  wireTerminalDiagnostics({ logger: fakeLogger, dumpDir });
});
afterEach(() => {
  resetTerminalDiagnosticsForTest();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("reportTerminalCorruption", () => {
  it("nests detector detail so it cannot clobber reserved record fields", () => {
    reportTerminalCorruption({
      kind: "replacement_char",
      pane: "pane-1",
      // A detail field named like a reserved key must not overwrite it.
      detail: { kind: "spoofed", count: 999, pane: "spoofed" },
    });
    const record = logged.find((entry) => entry.message === "Terminal corruption signal.");
    expect(record?.attributes.kind).toBe("replacement_char");
    expect(record?.attributes.count).toBe(1);
    expect(record?.attributes.pane).toBe("pane-1");
    expect(record?.attributes.detail).toMatchObject({ kind: "spoofed", count: 999 });
  });

  it("folds excess distinct keyed buckets into one overflow bucket", () => {
    for (let index = 0; index < 400; index += 1) {
      reportTerminalCorruption({ kind: "unhandled_sequence", key: `osc:${index}` });
    }
    const buckets = Object.keys(terminalCorruptionCounters());
    expect(buckets.length).toBeLessThanOrEqual(300);
    expect(buckets).toContain("unhandled_sequence:_overflow");
  });
});

describe("writePaneEvidenceDump", () => {
  it("redacts secrets in rows and the raw tail before writing", async () => {
    const githubToken = ["ghp", "_abcdef0123456789abcdef"].join("");
    const apiToken = ["sk", "-abcdefghijklmnop0123456789"].join("");
    writePaneEvidenceDump({
      pane: "pane-secret",
      trigger: "geometry_divergence",
      evidence: {
        rows: [`export GITHUB_TOKEN=${githubToken}`],
        rawTail: `Authorization: Bearer ${apiToken}`,
      },
    });
    await waitFor(() => readdirSync(dumpDir).length >= 1);
    const [name] = readdirSync(dumpDir);
    const dump = JSON.parse(await readFile(join(dumpDir, name ?? ""), "utf8"));
    expect(JSON.stringify(dump)).not.toContain(githubToken);
    expect(JSON.stringify(dump)).not.toContain(apiToken);
    expect(JSON.stringify(dump)).toContain("[REDACTED]");
  });

  it("only rate-limits the pane once a write lands, and logs write failures", async () => {
    wireTerminalDiagnostics({ logger: fakeLogger, dumpDir: join(dumpDir, "missing", "\0bad") });
    writePaneEvidenceDump({
      pane: "pane-fail",
      trigger: "geometry_divergence",
      evidence: { rows: [], rawTail: "" },
    });
    await waitFor(() => logged.some((r) => r.message === "Pane corruption evidence write failed."));
    // The failed write must not have stamped the rate limit, so a later capture
    // to a working dir still goes through.
    wireTerminalDiagnostics({ logger: fakeLogger, dumpDir });
    writePaneEvidenceDump({
      pane: "pane-fail",
      trigger: "geometry_divergence",
      evidence: { rows: ["ok"], rawTail: "ok" },
    });
    await waitFor(() => readdirSync(dumpDir).length >= 1);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await sleep(5);
  }
}
