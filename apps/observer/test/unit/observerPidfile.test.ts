import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ObserverProcessIdentity } from "@station/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createObserverProcessIdentity,
  observerPidfilePath,
  publishObserverProcessIdentity,
  readObserverProcessIdentity,
  removeObserverProcessIdentity,
} from "../../src/runtime/observerPidfile.js";

describe("observer pidfile", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
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
      "ps",
      ["-ww", "-p", String(process.pid), "-o", "lstart="],
      { encoding: "utf8" },
    ).trim();

    expect(
      createObserverProcessIdentity({
        pid: process.pid,
        version: "1.2.3",
        socketPath,
      }),
    ).toEqual({
      pid: process.pid,
      osStartTime: expectedStartTime,
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
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(identity);
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
});

function processIdentity(socketPath: string): ObserverProcessIdentity {
  return {
    pid: process.pid,
    osStartTime: "Sat Jul 11 12:34:56 2026",
    version: "1.2.3",
    socketPath,
  };
}
