import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalObserverProcessEvidence,
  parseObserverProcessList,
  parseUnixSocketFdCount,
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
        startupTimeoutMs: 10_000,
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

  it("strictly counts all Unix-domain socket descriptors for one process", () => {
    expect(parseUnixSocketFdCount("", 42)).toBe(0);
    expect(parseUnixSocketFdCount("p42\nf7u\nnsocket-a\nf9\nnsocket-b\n", 42)).toBe(2);
    expect(() => parseUnixSocketFdCount("p43\nf7\nnsocket-a\n", 42)).toThrow("unexpected process");
    expect(() => parseUnixSocketFdCount("p42\nmalformed\n", 42)).toThrow("malformed");
    expect(() => parseUnixSocketFdCount("p42\nnsocket-without-fd\n", 42)).toThrow("malformed");
  });

  it("distinguishes zero descriptors from unavailable lsof evidence", () => {
    const zero = createLocalObserverProcessEvidence({
      execFileStatus: () => ({ status: 1, stdout: "", stderr: "" }),
    });
    const one = createLocalObserverProcessEvidence({
      execFileStatus: () => ({ status: 0, stdout: "p42\nf7\nnsocket-a\n", stderr: "" }),
    });
    const unavailable = createLocalObserverProcessEvidence({
      execFileStatus: () => ({ status: 2, stdout: "", stderr: "lsof failed" }),
    });
    const ambiguousEmpty = createLocalObserverProcessEvidence({
      execFileStatus: () => ({ status: 1, stdout: "", stderr: "permission denied" }),
    });

    expect(zero.unixSocketFdCount(42)).toBe(0);
    expect(one.unixSocketFdCount(42)).toBe(1);
    expect(() => unavailable.unixSocketFdCount(42)).toThrow("evidence failed");
    expect(() => ambiguousEmpty.unixSocketFdCount(42)).toThrow("evidence failed");
  });

  it("normalizes strict holders, start-token, absence, and refusal results", () => {
    const execFile = vi.fn((_file: string, args: readonly string[]) => {
      if (args.includes("pid=,lstart=,command=")) return "";
      if (args.includes("lstart=")) return "Sat Jul  4 17:45:33 2026\n";
      return "";
    });
    const sent = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (signal === "SIGTERM") return;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const socketHolders = vi.fn(() => [10, 20]);
    const evidence = createLocalObserverProcessEvidence({ execFile, socketHolders, signal: sent });

    expect(evidence.socketHolders("/a/o.sock")).toEqual([10, 20]);
    expect(evidence.listObserverProcesses()).toEqual([]);
    expect(evidence.processStartToken(10)).toBe("Sat Jul  4 17:45:33 2026");
    expect(evidence.signal(10, "SIGTERM")).toBe("sent");
    expect(evidence.signal(10, 0)).toBe("absent");
    const expectedPs = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
    expect(socketHolders).toHaveBeenCalledWith("/a/o.sock");
    expect(execFile.mock.calls.map(([file]) => file)).toEqual([expectedPs, expectedPs]);
  });

  it("propagates unavailable holder evidence instead of reporting zero owners", () => {
    const evidence = createLocalObserverProcessEvidence({
      socketHolders: () => {
        throw Object.assign(new Error("unavailable"), {
          code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE",
        });
      },
    });

    expect(() => evidence.socketHolders("/a/o.sock")).toThrow(
      expect.objectContaining({ code: "PROTOCOL_SOCKET_EVIDENCE_UNAVAILABLE" }),
    );
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
