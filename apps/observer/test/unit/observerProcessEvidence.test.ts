import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SafeError } from "@station/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalObserverProcessEvidence,
  parseObserverProcessList,
  parseUnixSocketFdCount,
} from "../../src/runtime/observerProcessEvidence.js";

const BUILD = `1.2.3+station.${"a".repeat(64)}`;
const TOKEN = ["a47ac10b", "58cc", "4372", "a567", "0e02b2c3d479"].join("-");

describe("local Observer process evidence", () => {
  it("parses only source and compiled Observer argv with resolved sockets", () => {
    const output = [
      ` 3740 Sat Jul  4 17:45:33 2026 /opt/node/bin/node /repo/apps/cli/dist/observerMain.js --socket /a/o.sock --state-dir /a/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}`,
      ` 4001 Sat Jul  4 17:45:34 2026 /opt/station/stn __observer --socket /b/o.sock --state-dir /b/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}`,
      ` 4005 Sat Jul  4 17:45:36 2026 /opt/station/stn __observer --socket /tmp/socket with spaces/observer.sock --state-dir /tmp/state with spaces --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}`,
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
        ` 4006 Sat Jul  4 17:45:37 2026 ${executable} __observer --socket /tmp/observer.sock --state-dir /tmp/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}`,
        ` 4007 Sat Jul  4 17:45:38 2026 /bin/sh -c ${executable} __observer --socket /tmp/observer.sock --state-dir /tmp/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}`,
      ].join("\n");

      expect(parseObserverProcessList(output)).toEqual([
        expect.objectContaining({
          pid: 4006,
          socketPath: "/tmp/observer.sock",
        }),
        expect.objectContaining({ pid: 4007 }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when flattened argv points at a shell wrapper or repeated flag", async () => {
    const wrapper = ` 4007 Sat Jul  4 17:45:38 2026 /bin/sh -c /opt/station/stn __observer --socket /tmp/observer.sock --state-dir /tmp/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}\n`;
    const evidence = createLocalObserverProcessEvidence({
      execFile: () => wrapper,
      readProcessArgv: () => undefined,
      processExecutableProvenance: () => "mismatch",
    });

    expect(() => evidence.listObserverProcesses()).toThrow(
      expect.objectContaining({
        tag: "ObserverProcessEvidenceError",
        code: "OBSERVER_PROCESS_EXECUTABLE_ARGV_MISMATCH",
        message: "Observer process evidence did not match the exact executable and argv.",
      }),
    );
    expect(() =>
      parseObserverProcessList(
        wrapper.replace(" --state-dir /tmp/state", " --socket /spoof --state-dir /tmp/state"),
      ),
    ).toThrow("ambiguous");
  });

  it("reads one requested process without validating unrelated global entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stn-process-evidence-"));
    const executable = join(dir, "stn");
    const deletedExecutable = join(dir, "deleted", "stn");
    await writeFile(executable, "");
    const target = ` 42 Sat Jul  4 17:45:33 2026 ${executable} __observer --socket /tmp/observer.sock --state-dir /tmp/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}`;
    const unrelated = ` 43 Sat Jul  4 17:45:34 2026 ${deletedExecutable} __observer --socket /tmp/unrelated.sock --state-dir /tmp/unrelated --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}`;
    const execFile = vi.fn((_file: string, args: readonly string[]) =>
      args.includes("-axww") ? `${target}\n${unrelated}\n` : `${target}\n`,
    );
    const evidence = createLocalObserverProcessEvidence({
      execFile,
      readProcessArgv: () => undefined,
      processExecutableProvenance: () => "exact",
    });

    try {
      expect(evidence.readObserverProcess(42)).toMatchObject({ pid: 42 });
      expect(execFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["-p", "42"]),
        1_000,
      );
      expect(() => evidence.listObserverProcesses()).toThrow("ENOENT");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps replaced installed-path evidence on the cooperative-only port", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stn-process-evidence-"));
    const executable = join(dir, "stn");
    await writeFile(executable, "");
    const listing = ` 42 Sat Jul  4 17:45:33 2026 ${executable} __observer --socket /tmp/observer.sock --state-dir /tmp/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}\n`;
    const evidence = createLocalObserverProcessEvidence({
      execFile: () => listing,
      readProcessArgv: () => undefined,
      processExecutableProvenance: () => "installed-path-replaced",
    });
    try {
      expect(evidence.readCooperativeObserverProcess(42)).toMatchObject({
        executableProvenance: "installed-path-replaced",
      });
      expect(() => evidence.readObserverProcess(42)).toThrow(
        expect.objectContaining({ code: "OBSERVER_PROCESS_INSTALLED_PATH_REPLACED" }),
      );
      expect(() => evidence.listObserverProcesses()).toThrow(
        expect.objectContaining({ code: "OBSERVER_PROCESS_INSTALLED_PATH_REPLACED" }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not let a same-second PID replacement inherit a launch nonce", () => {
    const replacementToken = ["b47ac10b", "58cc", "4372", "a567", "0e02b2c3d479"].join("-");
    const output = [
      ` 42 Sat Jul  4 17:45:33 2026 /opt/station/stn __observer --socket /tmp/observer.sock --state-dir /tmp/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}`,
      ` 43 Sat Jul  4 17:45:33 2026 /opt/station/stn __observer --socket /tmp/observer.sock --state-dir /tmp/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${replacementToken}`,
    ].join("\n");

    const entries = parseObserverProcessList(output);
    expect(entries.map((entry) => entry.startToken)).toEqual([
      "Sat Jul  4 17:45:33 2026",
      "Sat Jul  4 17:45:33 2026",
    ]);
    expect(entries.map((entry) => entry.processToken)).toEqual([TOKEN, replacementToken]);
  });

  it("strictly counts all Unix-domain socket descriptors for one process", () => {
    expect(parseUnixSocketFdCount("p42\0\nfcwd\0tDIR\0\nf1\0tPIPE\0\n", 42)).toBe(0);
    expect(parseUnixSocketFdCount("p42\0\nfcwd\0tDIR\0\nf7u\0tunix\0\nf9\0tunix\0\n", 42)).toBe(2);
    expect(() => parseUnixSocketFdCount("", 42)).toThrow("truncated");
    expect(() => parseUnixSocketFdCount("p43\0\nf7\0tunix\0\n", 42)).toThrow("unexpected process");
    expect(() => parseUnixSocketFdCount("p42\0\nmalformed\0\n", 42)).toThrow("malformed");
  });

  it("distinguishes complete zero-descriptor evidence from unavailable lsof evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stn-process-evidence-"));
    const executable = join(dir, "stn");
    await writeFile(executable, "");
    const listing = ` 42 Sat Jul  4 17:45:33 2026 ${executable} __observer --socket /tmp/observer.sock --state-dir /tmp/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}\n`;
    const base = {
      execFile: () => listing,
      readProcessArgv: () => undefined,
      processExecutableProvenance: () => "exact",
    };
    const zero = createLocalObserverProcessEvidence({
      ...base,
      execFileStatus: () => ({
        status: 0,
        stdout: "p42\0\nfcwd\0tDIR\0\nf1\0tPIPE\0\n",
        stderr: "",
      }),
    });
    const one = createLocalObserverProcessEvidence({
      ...base,
      execFileStatus: () => ({
        status: 0,
        stdout: "p42\0\nfcwd\0tDIR\0\nf7\0tunix\0\n",
        stderr: "",
      }),
    });
    const unavailable = createLocalObserverProcessEvidence({
      ...base,
      execFileStatus: () => ({ status: 2, stdout: "", stderr: "lsof failed" }),
    });
    const statusOne = createLocalObserverProcessEvidence({
      ...base,
      execFileStatus: () => ({ status: 1, stdout: "", stderr: "" }),
    });
    const emptySuccess = createLocalObserverProcessEvidence({
      ...base,
      execFileStatus: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    const denied = createLocalObserverProcessEvidence({
      ...base,
      execFileStatus: () => ({ status: 1, stdout: "", stderr: "permission denied" }),
    });
    const missing = createLocalObserverProcessEvidence({
      ...base,
      execFileStatus: () => {
        throw Object.assign(new Error("spawn lsof ENOENT"), { code: "ENOENT" });
      },
    });

    try {
      const entry = zero.listObserverProcesses()[0];
      if (entry === undefined) throw new Error("Expected one Observer process entry.");
      expect(zero.unixSocketFdCount(entry)).toBe(0);
      expect(one.unixSocketFdCount(entry)).toBe(1);
      expect(() => unavailable.unixSocketFdCount(entry)).toThrow("evidence failed");
      expect(() => statusOne.unixSocketFdCount(entry)).toThrow("evidence failed");
      expect(() => emptySuccess.unixSocketFdCount(entry)).toThrow("truncated");
      expect(() => denied.unixSocketFdCount(entry)).toThrow("evidence failed");
      expect(() => missing.unixSocketFdCount(entry)).toThrow("ENOENT");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a process that exits or changes while descriptors are collected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stn-process-evidence-"));
    const executable = join(dir, "stn");
    await writeFile(executable, "");
    const listing = ` 42 Sat Jul  4 17:45:33 2026 ${executable} __observer --socket /tmp/observer.sock --state-dir /tmp/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}\n`;
    let reads = 0;
    const evidence = createLocalObserverProcessEvidence({
      execFile: () => (reads++ < 2 ? listing : ""),
      readProcessArgv: () => undefined,
      processExecutableProvenance: () => "exact",
      execFileStatus: () => ({
        status: 0,
        stdout: "p42\0\nfcwd\0tDIR\0\n",
        stderr: "",
      }),
    });

    try {
      const entry = evidence.listObserverProcesses()[0];
      if (entry === undefined) throw new Error("Expected one Observer process entry.");
      expect(() => evidence.unixSocketFdCount(entry)).toThrow("changed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    expect(socketHolders).toHaveBeenCalledWith("/a/o.sock", 1_000);
    expect(execFile.mock.calls.map(([file]) => file)).toEqual([expectedPs, expectedPs]);
  });

  it("preserves the configured fixed subprocess timeout for ordinary callers", () => {
    const timeouts: number[] = [];
    const evidence = createLocalObserverProcessEvidence({
      evidenceTimeoutMs: 250,
      nowMs: () => 10_000,
      execFile: (_file, args, timeoutMs) => {
        timeouts.push(timeoutMs);
        return args.includes("lstart=") ? "Sat Jul  4 17:45:33 2026\n" : "";
      },
    });

    expect(evidence.listObserverProcesses()).toEqual([]);
    expect(evidence.processStartToken(42)).toBe("Sat Jul  4 17:45:33 2026");
    expect(timeouts).toEqual([250, 250]);
  });

  it("shrinks every process-evidence subprocess seam from one absolute deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stn-process-evidence-"));
    const executable = join(dir, "stn");
    await writeFile(executable, "");
    let nowMs = 0;
    const calls: Array<{ kind: string; timeoutMs: number }> = [];
    const listing = ` 42 Sat Jul  4 17:45:33 2026 ${executable} __observer --socket /tmp/observer.sock --state-dir /tmp/state --startup-timeout-ms 10000 --build-version ${BUILD} --process-token ${TOKEN}\n`;
    const evidence = createLocalObserverProcessEvidence({
      evidenceTimeoutMs: 1_000,
      evidenceDeadlineMs: 1_000,
      nowMs: () => {
        nowMs += 10;
        return nowMs;
      },
      execFile: (_file, args, timeoutMs) => {
        calls.push({ kind: "exec", timeoutMs });
        return args.includes("pid=,lstart=,command=") ? listing : "Sat Jul  4 17:45:33 2026\n";
      },
      execFileStatus: (_file, args, timeoutMs) => {
        calls.push({ kind: "status", timeoutMs });
        return args.includes("-F0pft")
          ? { status: 0, stdout: "p42\0\nfcwd\0tDIR\0\n", stderr: "" }
          : { status: 0, stdout: "Sat Jul  4 17:45:33 2026\n", stderr: "" };
      },
      readProcessArgv: () => undefined,
      processExecutableProvenance: (_pid, _path, timeoutMs) => {
        calls.push({ kind: "provenance", timeoutMs });
        return "exact";
      },
      socketHolders: (_path, timeoutMs) => {
        calls.push({ kind: "holders", timeoutMs });
        return [42];
      },
    });

    try {
      const entry = evidence.listObserverProcesses()[0];
      if (entry === undefined) throw new Error("Expected one Observer process entry.");
      expect(evidence.socketHolders(entry.socketPath ?? "")).toEqual([42]);
      expect(evidence.processStartToken(entry.pid)).toBe("Sat Jul  4 17:45:33 2026");
      expect(evidence.readProcessExistence(entry.pid)).toMatchObject({ status: "running" });
      expect(evidence.unixSocketFdCount(entry)).toBe(0);
      expect(calls).toEqual([
        { kind: "exec", timeoutMs: 990 },
        { kind: "provenance", timeoutMs: 980 },
        { kind: "holders", timeoutMs: 970 },
        { kind: "exec", timeoutMs: 960 },
        { kind: "status", timeoutMs: 950 },
        { kind: "exec", timeoutMs: 940 },
        { kind: "provenance", timeoutMs: 930 },
        { kind: "status", timeoutMs: 920 },
        { kind: "exec", timeoutMs: 910 },
        { kind: "provenance", timeoutMs: 900 },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses process evidence before spawning after the absolute deadline", () => {
    const execFile = vi.fn(() => "");
    const evidence = createLocalObserverProcessEvidence({
      evidenceDeadlineMs: 1_000,
      nowMs: () => 1_000,
      execFile,
    });

    let first: SafeError | undefined;
    try {
      evidence.listObserverProcesses();
    } catch (error) {
      first = error as SafeError;
    }
    expect(first).toMatchObject({ code: "OBSERVER_PROCESS_EVIDENCE_DEADLINE_EXCEEDED" });
    if (first === undefined) throw new Error("Expected deadline evidence refusal.");
    first.code = "MUTATED_BY_CALLER";
    expect(() => evidence.listObserverProcesses()).toThrow(
      expect.objectContaining({ code: "OBSERVER_PROCESS_EVIDENCE_DEADLINE_EXCEEDED" }),
    );
    expect(execFile).not.toHaveBeenCalled();
  });

  it("distinguishes bounded process existence from unavailable evidence without signaling", () => {
    const running = createLocalObserverProcessEvidence({
      execFileStatus: () => ({
        status: 0,
        stdout: "Sat Jul  4 17:45:33 2026\n",
        stderr: "",
      }),
    });
    const absent = createLocalObserverProcessEvidence({
      execFileStatus: () => ({ status: 1, stdout: "", stderr: "" }),
    });
    const unavailable = createLocalObserverProcessEvidence({
      execFileStatus: () => ({ status: 2, stdout: "", stderr: "ps failed" }),
    });
    const invalidPid = createLocalObserverProcessEvidence({
      execFileStatus: () => ({ status: 1, stdout: "", stderr: "process id too large" }),
    });

    expect(running.readProcessExistence(42)).toEqual({
      status: "running",
      osStartTime: "Sat Jul  4 17:45:33 2026",
    });
    expect(absent.readProcessExistence(42)).toEqual({ status: "absent" });
    expect(unavailable.readProcessExistence(42)).toMatchObject({
      status: "unavailable",
      cause: expect.any(Error),
    });
    expect(invalidPid.readProcessExistence(42)).toMatchObject({
      status: "unavailable",
      cause: expect.any(Error),
    });
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
