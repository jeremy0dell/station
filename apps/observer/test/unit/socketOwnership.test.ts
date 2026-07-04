import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSocketIdentity, watchSocketOwnership } from "../../src/runtime/socketOwnership.js";

describe("watchSocketOwnership", () => {
  let dir: string;

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error("waitFor timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("fires onLost when the socket path is replaced by another inode", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-ownership-"));
    const socketPath = join(dir, "observer.sock");
    await writeFile(socketPath, "");

    let lost = false;
    const watch = watchSocketOwnership({
      socketPath,
      intervalMs: 20,
      onLost: () => {
        lost = true;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lost).toBe(false);

    await unlink(socketPath);
    await writeFile(socketPath, "");
    await waitFor(() => lost);
    watch.stop();
  });

  it("fires onLost when the socket path disappears", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-ownership-"));
    const socketPath = join(dir, "observer.sock");
    await writeFile(socketPath, "");

    let lost = false;
    const watch = watchSocketOwnership({
      socketPath,
      intervalMs: 20,
      onLost: () => {
        lost = true;
      },
    });

    await unlink(socketPath);
    await waitFor(() => lost);
    watch.stop();
  });

  it("seeded with its own identity does not fire on its own socket", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-ownership-"));
    const socketPath = join(dir, "observer.sock");
    await writeFile(socketPath, "");
    const identity = await readSocketIdentity(socketPath);
    expect(identity).toBeDefined();

    let lost = false;
    const watch = watchSocketOwnership({
      socketPath,
      intervalMs: 20,
      ...(identity === undefined ? {} : { expectedIdentity: identity }),
      onLost: () => {
        lost = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lost).toBe(false);
    watch.stop();
  });

  it("seeded watcher detects a takeover that happened before it was armed", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-ownership-"));
    const socketPath = join(dir, "observer.sock");
    await writeFile(socketPath, "");
    const identity = await readSocketIdentity(socketPath);
    if (identity === undefined) throw new Error("expected a socket identity");
    // The live socket already differs from what this process thinks it bound (a
    // rival rebound it before the watch was armed). Deterministic — no reliance
    // on filesystem inode reuse.
    const staleSeed = { ino: identity.ino + 1n, birthtimeNs: identity.birthtimeNs };

    let lost = false;
    const watch = watchSocketOwnership({
      socketPath,
      intervalMs: 20,
      expectedIdentity: staleSeed,
      onLost: () => {
        lost = true;
      },
    });
    await waitFor(() => lost); // fires on the first probe
    watch.stop();
  });

  it("does not fire after stop", async () => {
    dir = await mkdtemp(join(tmpdir(), "stn-ownership-"));
    const socketPath = join(dir, "observer.sock");
    await writeFile(socketPath, "");

    let lost = false;
    const watch = watchSocketOwnership({
      socketPath,
      intervalMs: 20,
      onLost: () => {
        lost = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    watch.stop();
    await unlink(socketPath);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(lost).toBe(false);
  });
});
