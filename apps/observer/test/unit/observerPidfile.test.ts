import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ObserverProcessIdentity } from "@station/contracts";
import { safeErrorFromUnknown } from "@station/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createObserverProcessIdentity,
  observerPidfilePath,
  publishObserverProcessIdentity,
  readObserverProcessIdentity,
  removeObserverProcessIdentity,
} from "../../src/runtime/observerPidfile.js";

const PROCESS_TOKEN = ["a47ac10b", "58cc", "4372", "a567", "0e02b2c3d479"].join("-");
const REPLACEMENT_PROCESS_TOKEN = ["b47ac10b", "58cc", "4372", "a567", "0e02b2c3d479"].join("-");

const pidfileFailures = vi.hoisted(() => ({
  failClaimedLink: false,
  failClaimedUnlink: false,
  linkError: new Error("pidfile restoration failed"),
  unlinkError: new Error("pidfile removal failed"),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    link: async (...args: Parameters<typeof original.link>) => {
      if (pidfileFailures.failClaimedLink && String(args[0]).endsWith(".remove")) {
        throw pidfileFailures.linkError;
      }
      return original.link(...args);
    },
    unlink: async (...args: Parameters<typeof original.unlink>) => {
      if (pidfileFailures.failClaimedUnlink && String(args[0]).endsWith(".remove")) {
        throw pidfileFailures.unlinkError;
      }
      return original.unlink(...args);
    },
  };
});

describe("observer pidfile", () => {
  let dir: string | undefined;

  afterEach(async () => {
    pidfileFailures.failClaimedLink = false;
    pidfileFailures.failClaimedUnlink = false;
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("derives a socket-specific pidfile beside the socket", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-pidfile-"));
    const socketPath = join(dir, "runtime", "observer.sock");

    expect(observerPidfilePath(socketPath)).toBe(`${socketPath}.pid`);
    expect(observerPidfilePath(join(dir, "runtime", "alternate.sock"))).not.toBe(
      observerPidfilePath(socketPath),
    );
  });

  it("builds identity with the trimmed OS start-time token", () => {
    const socketPath = "/tmp/station/observer.sock";
    const expectedStartTime = execFileSync(
      process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps",
      ["-ww", "-p", String(process.pid), "-o", "lstart="],
      { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
    ).trim();

    expect(
      createObserverProcessIdentity({
        pid: process.pid,
        processToken: PROCESS_TOKEN,
        version: "1.2.3",
        socketPath,
      }),
    ).toEqual({
      pid: process.pid,
      osStartTime: expectedStartTime,
      processToken: PROCESS_TOKEN,
      version: "1.2.3",
      socketPath,
    });
  });

  it("reads the OS start-time token without relying on PATH", () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(
        createObserverProcessIdentity({
          pid: process.pid,
          processToken: PROCESS_TOKEN,
          version: "1.2.3",
          socketPath: "/tmp/station/observer.sock",
        }).osStartTime,
      ).not.toBe("");
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  it("atomically publishes a private strict identity beside the socket", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-pidfile-"));
    const socketDir = join(dir, "runtime");
    const socketPath = join(socketDir, "custom.sock");
    const identity = processIdentity(socketPath);
    await mkdir(socketDir);
    await writeFile(observerPidfilePath(socketPath), "{}\n", { mode: 0o644 });

    await publishObserverProcessIdentity(identity);

    const path = observerPidfilePath(socketPath);
    expect(await readObserverProcessIdentity(socketPath)).toEqual(identity);
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(identity)}\n`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(socketDir)).toEqual([basename(observerPidfilePath(socketPath))]);
  });

  it("removes its temporary file when publication fails", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-pidfile-"));
    const socketPath = join(dir, "observer.sock");
    const path = observerPidfilePath(socketPath);
    await mkdir(path);

    await expect(publishObserverProcessIdentity(processIdentity(socketPath))).rejects.toThrow();

    expect(await readdir(dir)).toEqual([basename(observerPidfilePath(socketPath))]);
  });

  it("strictly parses the published identity", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-pidfile-"));
    const socketPath = join(dir, "observer.sock");
    const path = observerPidfilePath(socketPath);
    const identity = processIdentity(socketPath);
    await writeFile(path, JSON.stringify({ ...identity, unexpected: true }), { mode: 0o600 });

    await expect(readObserverProcessIdentity(socketPath)).rejects.toThrow();
  });

  it("returns undefined when no identity has been published", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-pidfile-"));
    const socketPath = join(dir, "observer.sock");

    await expect(readObserverProcessIdentity(socketPath)).resolves.toBeUndefined();
  });

  it("removes the pidfile only when every identity field matches", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-pidfile-"));
    const socketPath = join(dir, "observer.sock");
    const identity = processIdentity(socketPath);
    await publishObserverProcessIdentity(identity);

    await expect(removeObserverProcessIdentity(identity)).resolves.toBe(true);
    await expect(readObserverProcessIdentity(socketPath)).resolves.toBeUndefined();
  });

  it("never removes a successor identity published during cleanup", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-pidfile-"));
    const socketPath = join(dir, "observer.sock");
    const identity = processIdentity(socketPath);
    const successor: ObserverProcessIdentity = {
      ...identity,
      pid: identity.pid + 1,
      osStartTime: "Sat Jul 11 12:35:56 2026",
    };
    await publishObserverProcessIdentity(identity);

    await Promise.all([
      removeObserverProcessIdentity(identity),
      publishObserverProcessIdentity(successor),
    ]);

    await expect(readObserverProcessIdentity(socketPath)).resolves.toEqual(successor);
    await expect(readdir(dir)).resolves.toEqual([basename(observerPidfilePath(socketPath))]);
  });

  it.each([
    ["pid", { pid: process.pid + 1 }],
    ["osStartTime", { osStartTime: "Mon Jan  1 00:00:00 2001" }],
    ["processToken", { processToken: REPLACEMENT_PROCESS_TOKEN }],
    ["version", { version: "9.9.9" }],
    ["socketPath", { socketPath: "/tmp/other/observer.sock" }],
  ] as const)("leaves the pidfile when %s does not match", async (_field, replacement) => {
    dir = await mkdtemp(join(tmpdir(), "stn-pidfile-"));
    const socketPath = join(dir, "observer.sock");
    const expected = processIdentity(socketPath);
    const current = { ...expected, ...replacement } as ObserverProcessIdentity;
    await writeFile(observerPidfilePath(socketPath), `${JSON.stringify(current)}\n`, {
      mode: 0o600,
    });

    await expect(removeObserverProcessIdentity(expected)).resolves.toBe(false);
    await expect(readObserverProcessIdentity(socketPath)).resolves.toEqual(current);
    await expect(readdir(dir)).resolves.toEqual([basename(observerPidfilePath(socketPath))]);
  });

  it("leaves malformed identity files untouched", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-pidfile-"));
    const socketPath = join(dir, "observer.sock");
    const path = observerPidfilePath(socketPath);
    await writeFile(path, "{}\n", { mode: 0o600 });

    await expect(removeObserverProcessIdentity(processIdentity(socketPath))).rejects.toThrow();
    await expect(readFile(path, "utf8")).resolves.toBe("{}\n");
    await expect(readdir(dir)).resolves.toEqual([basename(observerPidfilePath(socketPath))]);
  });

  it("preserves both failures when pidfile removal and restoration fail", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-pidfile-"));
    const socketPath = join(dir, "observer.sock");
    const identity = processIdentity(socketPath);
    await publishObserverProcessIdentity(identity);
    pidfileFailures.failClaimedUnlink = true;
    pidfileFailures.failClaimedLink = true;

    let failure: unknown;
    try {
      await removeObserverProcessIdentity(identity);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      pidfileFailures.unlinkError,
      pidfileFailures.linkError,
    ]);
    expect((failure as AggregateError).message).toContain("could not be removed or restored");
    expect(
      safeErrorFromUnknown(failure, {
        tag: "ObserverLifecycleError",
        code: "OBSERVER_IDENTITY_REMOVE_FAILED",
        message: "Observer process identity could not be removed.",
      }),
    ).toEqual({
      tag: "ObserverLifecycleError",
      code: "OBSERVER_IDENTITY_REMOVE_AND_RESTORE_FAILED",
      message: "Observer process identity could not be removed or restored.",
    });
    await expect(readObserverProcessIdentity(socketPath)).resolves.toBeUndefined();
    const entries = await readdir(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\.observer\.pid\..+\.remove$/);
  });
});

function processIdentity(socketPath: string): ObserverProcessIdentity {
  return {
    pid: process.pid,
    osStartTime: "Sat Jul 11 12:34:56 2026",
    processToken: PROCESS_TOKEN,
    version: "1.2.3",
    socketPath,
  };
}
