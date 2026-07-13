import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalObserverProcessEvidence,
  parseObserverProcessList,
} from "../../src/runtime/observerProcessEvidence.js";

describe("local Observer process evidence", () => {
  it("parses only source and compiled Observer argv with resolved sockets", () => {
    const output = [
      " 3740 Sat Jul  4 17:45:33 2026 /opt/node/bin/node /repo/apps/cli/dist/observerMain.js --socket /a/o.sock",
      " 4001 Sat Jul  4 17:45:34 2026 /opt/station/stn __observer --socket /b/o.sock",
      " 4005 Sat Jul  4 17:45:36 2026 /opt/station/stn __observer --socket /tmp/socket with spaces/observer.sock --startup-timeout-ms 10000",
      " 4002 Sat Jul  4 17:45:35 2026 /opt/station/stn observer start --socket /wrong.sock",
      "19359 Sat Jul  4 17:47:24 2026 /bin/zsh -c grep observerMain.js",
    ].join("\n");

    expect(parseObserverProcessList(output)).toEqual([
      expect.objectContaining({ pid: 3740, socketPath: "/a/o.sock" }),
      expect.objectContaining({ pid: 4001, socketPath: "/b/o.sock" }),
      expect.objectContaining({
        pid: 4005,
        socketPath: "/tmp/socket with spaces/observer.sock",
      }),
    ]);
  });

  it("recognizes a compiled Observer executable path containing spaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stn-process-evidence-"));
    const executable = join(dir, "Station App", "stn");
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, "");
    try {
      const output = [
        ` 4006 Sat Jul  4 17:45:37 2026 ${executable} __observer --socket /tmp/observer.sock`,
        ` 4007 Sat Jul  4 17:45:38 2026 /bin/sh -c ${executable} __observer --socket /tmp/observer.sock`,
      ].join("\n");

      expect(parseObserverProcessList(output)).toEqual([
        expect.objectContaining({
          pid: 4006,
          socketPath: "/tmp/observer.sock",
        }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("normalizes lsof, start-token, absence, and refusal results", () => {
    const execFile = vi.fn((file: string, args: readonly string[]) => {
      if (file.endsWith("/lsof")) return "10\n20\nnot-a-pid\n";
      if (args.includes("pid=,lstart=,command=")) return "";
      if (args.includes("lstart=")) return "Sat Jul  4 17:45:33 2026\n";
      return "";
    });
    const sent = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGTERM") return;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const evidence = createLocalObserverProcessEvidence({ execFile, signal: sent });

    expect(evidence.socketHolders("/a/o.sock")).toEqual([10, 20]);
    expect(evidence.listObserverProcesses()).toEqual([]);
    expect(evidence.processStartToken(10)).toBe("Sat Jul  4 17:45:33 2026");
    expect(evidence.signal(10, "SIGTERM")).toBe("sent");
    expect(evidence.signal(10, 0)).toBe("absent");
    const expectedPs = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
    const expectedLsof = process.platform === "darwin" ? "/usr/sbin/lsof" : "/usr/bin/lsof";
    expect(execFile.mock.calls.map(([file]) => file)).toEqual([
      expectedLsof,
      expectedPs,
      expectedPs,
    ]);
  });

  it("treats permission errors as refusal instead of absence", () => {
    const evidence = createLocalObserverProcessEvidence({
      signal: () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    });

    expect(evidence.signal(10, "SIGTERM")).toBe("refused");
  });
});
