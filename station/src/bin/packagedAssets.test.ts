import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  preparePackagedPiExtension,
  preparePackagedPtyRuntime,
  type PackagedAssetDeps,
  type PreparedPtyRuntime,
} from "./packagedAssets.js";

const tempDirs: string[] = [];
const runtimes: PreparedPtyRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    runtime.dispose();
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  delete process.env.STATION_PTY_IMPL;
});

async function stateDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "station-packaged-assets-"));
  tempDirs.push(path);
  return path;
}

async function assetPaths(state: string): Promise<{ helper: string; pi: string }> {
  const sourceDir = join(state, "embedded-source");
  const helper = join(sourceDir, "ctty-helper");
  const pi = join(sourceDir, "piExtension.mjs");
  await mkdir(sourceDir, { recursive: true });
  await Promise.all([
    writeFixture(helper, "test ctty helper bytes"),
    writeFixture(pi, "export const stationPiTest = true;\n"),
  ]);
  return { helper, pi };
}

async function writeFixture(path: string, contents: string): Promise<void> {
  try {
    await writeFile(path, contents, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

async function preparePty(
  state: string,
  deps: PackagedAssetDeps = {},
): Promise<PreparedPtyRuntime> {
  const { helper } = await assetPaths(state);
  return preparePackagedPtyRuntime(state, helper, {
    helperExitCode: async () => 64,
    ...deps,
  });
}

async function preparePi(state: string, deps: PackagedAssetDeps = {}): Promise<string> {
  const { pi } = await assetPaths(state);
  return preparePackagedPiExtension(state, pi, deps);
}

describe("preparePackagedPtyRuntime", () => {
  it("uses Bun by default and extracts an executable content-addressed helper", async () => {
    const state = await stateDir();
    const runtime = await preparePty(state);
    runtimes.push(runtime);

    expect(runtime.implementation).toBe("bun");
    const helper = await onlyHelper(state);
    expect((await lstat(helper)).mode & 0o777).toBe(0o700);
    expect((await lstat(dirname(helper))).mode & 0o777).toBe(0o700);
    expect(helper).toMatch(/\/ctty\/[^/]+-[a-f0-9]{64}\/station-ctty-helper$/);
  });

  it("repairs a corrupt regular helper without changing its identity", async () => {
    const state = await stateDir();
    const first = await preparePty(state);
    runtimes.push(first);
    const helper = await onlyHelper(state);
    const expected = await readFile(helper);

    first.dispose();
    await writeFile(helper, "corrupt");
    await chmod(helper, 0o600);
    const second = await preparePty(state);
    runtimes.push(second);

    expect(await onlyHelper(state)).toBe(helper);
    expect(await readFile(helper)).toEqual(expected);
    expect((await lstat(helper)).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlink at the immutable helper target", async () => {
    const state = await stateDir();
    const runtime = await preparePty(state);
    runtimes.push(runtime);
    const helper = await onlyHelper(state);
    runtime.dispose();
    await rm(helper);
    await symlink("/bin/true", helper);

    expect(await rejectionMessage(preparePty(state))).toContain(
      "Refusing non-regular packaged asset path",
    );
  });

  it("keeps bun-nocctty explicit and never extracts a helper", async () => {
    process.env.STATION_PTY_IMPL = "bun-nocctty";
    const state = await stateDir();
    const runtime = await preparePty(state);
    runtimes.push(runtime);

    expect(runtime.implementation).toBe("bun-nocctty");
    expect(await pathExists(join(state, "run", "assets"))).toBe(false);
  });

  it("rejects the source-only bridge instead of silently degrading", async () => {
    process.env.STATION_PTY_IMPL = "bridge";
    expect(await rejectionMessage(preparePty(await stateDir()))).toContain(
      "bridge is unavailable in the compiled Station binary",
    );
  });

  it("retains helper versions leased by live processes and prunes dead leases", async () => {
    const state = await stateDir();
    const ctty = join(state, "run", "assets", "ctty");
    const live = join(ctty, "old-live");
    const dead = join(ctty, "old-dead");
    await mkdir(join(live, ".leases"), { recursive: true });
    await mkdir(join(dead, ".leases"), { recursive: true });
    await writeFile(join(live, ".leases", `${process.pid}-live`), "");
    await writeFile(join(dead, ".leases", "2147483647-dead"), "");

    const runtime = await preparePty(state);
    runtimes.push(runtime);

    expect(await pathExists(live)).toBe(true);
    expect(await pathExists(dead)).toBe(false);
  });

  it("reclaims an extraction lock owned by a dead process", async () => {
    const state = await stateDir();
    const first = await preparePty(state);
    runtimes.push(first);
    const assetDir = dirname(await onlyHelper(state));
    first.dispose();
    await rm(assetDir, { recursive: true });
    await mkdir(`${assetDir}.lock`, { recursive: true });
    await writeFile(join(`${assetDir}.lock`, "owner-2147483647"), "");

    const second = await preparePty(state);
    runtimes.push(second);
    expect(await pathExists(join(assetDir, "station-ctty-helper"))).toBe(true);
    expect(await pathExists(`${assetDir}.lock`)).toBe(false);
  });

  it("times out on a live extraction owner without stealing its lock", async () => {
    const state = await stateDir();
    const first = await preparePty(state);
    runtimes.push(first);
    const assetDir = dirname(await onlyHelper(state));
    first.dispose();
    await rm(assetDir, { recursive: true });
    await mkdir(`${assetDir}.lock`, { recursive: true });
    await writeFile(join(`${assetDir}.lock`, `owner-${process.pid}`), "");

    expect(
      await rejectionMessage(
        preparePty(state, {
          lockTimeoutMs: 0,
          lockWaitMs: 0,
        }),
      ),
    ).toContain("Timed out waiting for packaged asset lock");
    expect(await pathExists(`${assetDir}.lock`)).toBe(true);
  });

  it("converges concurrent extraction on one complete helper", async () => {
    const state = await stateDir();
    const prepared = await Promise.all(Array.from({ length: 6 }, () => preparePty(state)));
    runtimes.push(...prepared);

    const helper = await onlyHelper(state);
    expect((await readFile(helper)).toString()).toBe("test ctty helper bytes");
    const siblings = await readdir(dirname(helper));
    expect(siblings.sort()).toEqual([".leases", "station-ctty-helper"]);
  });

  it("serializes first leases and pruning across helper identities", async () => {
    const state = await stateDir();
    const sourceDir = join(state, "identity-sources");
    const firstHelper = join(sourceDir, "first-helper");
    const secondHelper = join(sourceDir, "second-helper");
    await mkdir(sourceDir, { recursive: true });
    await Promise.all([
      writeFile(firstHelper, "first helper bytes"),
      writeFile(secondHelper, "second helper bytes"),
    ]);

    let releaseFirst!: () => void;
    let markFirstProbeStarted!: () => void;
    const firstProbeStarted = new Promise<void>((resolve) => {
      markFirstProbeStarted = resolve;
    });
    const firstProbeRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = preparePackagedPtyRuntime(state, firstHelper, {
      helperExitCode: async () => {
        markFirstProbeStarted();
        await firstProbeRelease;
        return 64;
      },
    });
    await firstProbeStarted;

    let secondSettled = false;
    const second = preparePackagedPtyRuntime(state, secondHelper, {
      helperExitCode: async () => 64,
    }).finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondSettled).toBe(false);

    releaseFirst();
    const prepared = await Promise.all([first, second]);
    runtimes.push(...prepared);
    const identityDirs = (await readdir(join(state, "run", "assets", "ctty"), {
      withFileTypes: true,
    })).filter((entry) => entry.isDirectory() && !entry.name.endsWith(".lock"));
    expect(identityDirs).toHaveLength(2);
    for (const entry of identityDirs) {
      expect(
        (await lstat(join(state, "run", "assets", "ctty", entry.name, "station-ctty-helper"))).isFile(),
      ).toBe(true);
    }
  });

  it("reports a noexec helper cache without falling back to bun-nocctty", async () => {
    const state = await stateDir();
    const denied = Object.assign(new Error("execution denied"), { code: "EACCES" });
    const message = await rejectionMessage(
      preparePty(state, {
        helperExitCode: async () => Promise.reject(denied),
      }),
    );

    expect(message).toContain("cannot execute");
    expect(message).toContain("[observer].state_dir");
    expect(message).not.toContain("bun-nocctty");
  });
});

describe("preparePackagedPiExtension", () => {
  it("extracts privately, repairs corruption, and retains older immutable bundles", async () => {
    const state = await stateDir();
    const first = await preparePi(state);
    const expected = await readFile(first);
    expect((await lstat(first)).mode & 0o777).toBe(0o600);

    await writeFile(first, "corrupt");
    const second = await preparePi(state);
    expect(second).toBe(first);
    expect(await readFile(second)).toEqual(expected);

    const retained = join(dirname(dirname(first)), "older-build", "station-pi-extension.mjs");
    await mkdir(dirname(retained), { recursive: true });
    await writeFile(retained, "old");
    await preparePi(state);
    expect(await pathExists(retained)).toBe(true);
  });
});

async function onlyHelper(state: string): Promise<string> {
  const root = join(state, "run", "assets", "ctty");
  const entries = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && !entry.name.endsWith(".lock"),
  );
  expect(entries).toHaveLength(1);
  return join(root, entries[0]?.name ?? "missing", "station-ctty-helper");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected promise to reject.");
}
