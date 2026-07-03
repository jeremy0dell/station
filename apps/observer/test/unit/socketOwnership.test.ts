import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { watchSocketOwnership } from "../../src/runtime/socketOwnership.js";

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
