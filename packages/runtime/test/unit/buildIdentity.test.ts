import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  removeBinaryOutputAfterSourceAdmission,
  runWithBunExecutable,
} from "../../../../scripts/build-binary.mjs";
import {
  assertNodeVersion,
  buildIdentityPath,
  buildInputMode,
  buildRepository,
  buildWithIdentity,
  buildWithToolchainIdentity,
  checkBuildIdentity,
  checkBuildToolchain,
  computeBuildIdentity,
  ensureBuildIdentity,
  ensureBuildWithToolchainIdentity,
  ensureRepositoryBuild,
  publishBuildIdentity,
  readBuildIdentity,
  runBuildChild,
  verifyBuildIdentity,
} from "../../../../scripts/build-identity.mjs";
import { requiredBunVersion, resolveAndCheckBunVersion } from "../../../../scripts/bun-version.mjs";
import { environmentWithoutGitLocals } from "../../src/gitEnvironment.js";

describe("build identity", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("is deterministic and changes with HEAD, inputs, modes, and production outputs", async () => {
    const root = await createRepository();
    roots.push(root);
    const trackedPath = join(root, "tracked.txt");
    const clean = await computeBuildIdentity(root);

    expect(clean).toMatch(/^[0-9a-f]{64}$/u);
    await expect(computeBuildIdentity(root)).resolves.toBe(clean);

    await writeFile(join(root, "packages", "example", "test", "value.test.ts"), "changed\n");
    await writeFile(join(root, "packages", "example", "value.spec.tsx"), "changed\n");
    await expect(computeBuildIdentity(root)).resolves.toBe(clean);

    await writeFile(trackedPath, "changed\n");
    const dirty = await computeBuildIdentity(root);
    expect(dirty).not.toBe(clean);
    await expect(computeBuildIdentity(root)).resolves.toBe(dirty);

    await writeFile(trackedPath, "tracked\n");
    await expect(computeBuildIdentity(root)).resolves.toBe(clean);

    const untrackedPath = join(root, "untracked.txt");
    await writeFile(untrackedPath, "one\n");
    const untracked = await computeBuildIdentity(root);
    await writeFile(untrackedPath, "two\n");
    expect(await computeBuildIdentity(root)).not.toBe(untracked);
    await rm(untrackedPath);

    const outputPath = join(root, "packages", "example", "dist", "index.js");
    await writeFile(outputPath, "export const build = 'changed';\n");
    expect(await computeBuildIdentity(root)).not.toBe(clean);
    await writeFile(outputPath, "export const build = 'current';\n");
    await expect(computeBuildIdentity(root)).resolves.toBe(clean);

    await chmod(trackedPath, 0o755);
    expect(await computeBuildIdentity(root)).not.toBe(clean);
    await chmod(trackedPath, 0o644);
    await expect(computeBuildIdentity(root)).resolves.toBe(clean);

    await writeFile(join(root, "ignored.txt"), "ignored\n");
    await expect(computeBuildIdentity(root)).resolves.toBe(clean);

    git(root, ["commit", "--allow-empty", "-m", "identity-only commit"]);
    expect(await computeBuildIdentity(root)).not.toBe(clean);
  });

  it("uses Git's platform-neutral mode for symlink inputs", () => {
    expect(buildInputMode({ mode: 0o755, isSymbolicLink: () => true })).toBe("777");
    expect(buildInputMode({ mode: 0o777, isSymbolicLink: () => true })).toBe("777");
    expect(buildInputMode({ mode: 0o755, isSymbolicLink: () => false })).toBe("755");
  });

  it("atomically publishes and validates the runtime sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-build-identity-sidecar-"));
    roots.push(root);
    const identity = "b".repeat(64);

    await publishBuildIdentity(identity, root);

    await expect(readBuildIdentity(root)).resolves.toBe(identity);
    expect(buildIdentityPath(root)).toBe(
      join(root, "packages", "runtime", "dist", "station-build-id"),
    );
    await expect(publishBuildIdentity("not-an-identity", root)).rejects.toThrow(
      "64 lowercase hexadecimal",
    );
  });

  it("verifies only the current published identity", async () => {
    const root = await createRepository();
    roots.push(root);
    const identity = await computeBuildIdentity(root);

    await expect(verifyBuildIdentity(identity, root)).resolves.toBe(false);
    await publishBuildIdentity(identity, root);
    await expect(verifyBuildIdentity(identity, root)).resolves.toBe(true);

    await writeFile(join(root, "tracked.txt"), "changed\n");
    await expect(verifyBuildIdentity(identity, root)).resolves.toBe(false);

    await writeFile(join(root, "tracked.txt"), "tracked\n");
    await writeFile(
      join(root, "packages", "example", "dist", "index.js"),
      "export const build = 'stale-output';\n",
    );
    await expect(verifyBuildIdentity(identity, root)).resolves.toBe(false);
  });

  it("checks a current identity without mutating it", async () => {
    const root = await createRepository();
    roots.push(root);
    const identity = await computeBuildIdentity(root);
    await publishBuildIdentity(identity, root);
    const before = await readFile(buildIdentityPath(root), "utf8");

    await expect(checkBuildIdentity(root)).resolves.toBe(identity);
    await expect(readFile(buildIdentityPath(root), "utf8")).resolves.toBe(before);
  });

  it("rejects missing, stale-input, and stale-output identities without mutation", async () => {
    const root = await createRepository();
    roots.push(root);

    await expect(checkBuildIdentity(root)).rejects.toThrow("missing or invalid");
    await expect(readBuildIdentity(root)).rejects.toMatchObject({ code: "ENOENT" });

    const identity = await computeBuildIdentity(root);
    await publishBuildIdentity(identity, root);
    await writeFile(join(root, "tracked.txt"), "changed\n");
    await expect(checkBuildIdentity(root)).rejects.toThrow("does not match");
    await expect(readBuildIdentity(root)).resolves.toBe(identity);

    await writeFile(join(root, "tracked.txt"), "tracked\n");
    await writeFile(
      join(root, "packages", "example", "dist", "index.js"),
      "export const build = 'stale-output';\n",
    );
    await expect(checkBuildIdentity(root)).rejects.toThrow("does not match");
    await expect(readBuildIdentity(root)).resolves.toBe(identity);
  });

  it("ensures current output without rebuilding and rebuilds stale states once", async () => {
    const root = await createRepository();
    roots.push(root);
    const current = await computeBuildIdentity(root);
    await publishBuildIdentity(current, root);
    let builds = 0;

    await expect(
      ensureBuildIdentity(root, async () => {
        builds += 1;
      }),
    ).resolves.toBe(current);
    expect(builds).toBe(0);

    await rm(buildIdentityPath(root));
    await expect(
      ensureBuildIdentity(root, async () => {
        builds += 1;
      }),
    ).resolves.toBe(current);
    expect(builds).toBe(1);

    await writeFile(join(root, "tracked.txt"), "changed\n");
    await expect(
      ensureBuildIdentity(root, async () => {
        builds += 1;
      }),
    ).resolves.toMatch(/^[0-9a-f]{64}$/u);
    expect(builds).toBe(2);

    await writeFile(
      join(root, "packages", "example", "dist", "index.js"),
      "export const build = 'stale-output';\n",
    );
    await expect(
      ensureBuildIdentity(root, async () => {
        builds += 1;
      }),
    ).resolves.toMatch(/^[0-9a-f]{64}$/u);
    expect(builds).toBe(3);
  });

  it("admits only the Node range declared by the root manifest", () => {
    expect(() => assertNodeVersion("v24.2.0", ">=24.2 <25")).not.toThrow();
    expect(() => assertNodeVersion("24.19.0", ">=24.2 <25")).not.toThrow();
    expect(() => assertNodeVersion("v24.1.9", ">=24.2 <25")).toThrow(
      "Station requires Node >=24.2 <25; found v24.1.9.",
    );
    expect(() => assertNodeVersion("v25.0.0", ">=24.2 <25")).toThrow(
      "Station requires Node >=24.2 <25; found v25.0.0.",
    );
  });

  it("rejects non-string package-manager and Node-engine policy fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-build-policy-"));
    roots.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: ["bun@1.4.0"], engines: { node: ">=24.2 <25" } }),
    );
    await expect(requiredBunVersion(root)).rejects.toThrow(
      'Root package.json must declare packageManager as exact "bun@<version>".',
    );

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "bun@1.4.0", engines: { node: [">=24.2 <25"] } }),
    );
    await expect(checkBuildToolchain(root)).rejects.toThrow(
      "Root package.json must declare engines.node as a supported range.",
    );
  });

  it("rejects unsupported build toolchains before replacing a stale identity", async () => {
    const root = await createRepository();
    roots.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "bun@1.4.0", engines: { node: ">=24.2 <25" } }),
    );
    git(root, ["add", "package.json"]);
    git(root, ["commit", "--quiet", "-m", "add toolchain policy"]);
    const identity = await computeBuildIdentity(root);
    await publishBuildIdentity(identity, root);
    await writeFile(join(root, "tracked.txt"), "stale\n");
    const outputPath = join(root, "packages", "example", "dist", "index.js");
    const outputBeforeRejection = await readFile(outputPath, "utf8");

    const toolRoot = await mkdtemp(join(tmpdir(), "station-build-toolchain-"));
    roots.push(toolRoot);
    const bin = join(toolRoot, "bin");
    const bunLog = join(toolRoot, "bun.log");
    await mkdir(bin);
    await writeFile(
      join(bin, "bun"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$STATION_TEST_BUN_LOG"\nif [ "$1" = --version ]; then printf \'1.3.14\\n\'; fi\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      STATION_TEST_BUN_LOG: bunLog,
    };
    let builds = 0;
    const runBuild = async () => {
      builds += 1;
    };

    await expect(
      buildWithToolchainIdentity(root, runBuild, { env, nodeVersion: "v22.14.0" }),
    ).rejects.toThrow("Station requires Node >=24.2 <25; found v22.14.0.");
    await expect(readFile(bunLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(buildIdentityPath(root), "utf8")).resolves.toBe(`${identity}\n`);
    await expect(readFile(outputPath, "utf8")).resolves.toBe(outputBeforeRejection);

    await expect(
      ensureBuildWithToolchainIdentity(root, runBuild, { env, nodeVersion: "v24.19.0" }),
    ).rejects.toThrow("Station requires Bun 1.4.0; found 1.3.14.");
    await expect(readFile(bunLog, "utf8")).resolves.toBe("--version\n");
    await expect(readFile(buildIdentityPath(root), "utf8")).resolves.toBe(`${identity}\n`);
    await expect(readFile(outputPath, "utf8")).resolves.toBe(outputBeforeRejection);
    expect(builds).toBe(0);

    await writeFile(
      join(bin, "bun"),
      '#!/bin/sh\nprintf \'%s\\t%s\\t%s\\n\' "$0" "$*" "$PATH" >> "$STATION_TEST_BUN_LOG"\nif [ "$1" = --version ]; then printf \'1.4.0\\n\'; fi\n',
      { mode: 0o755 },
    );
    await writeFile(bunLog, "");
    await buildRepository(root, { env, nodeVersion: "v24.19.0" });
    expect(builds).toBe(0);
    const exactBun = await realpath(join(bin, "bun"));
    await expect(readFile(bunLog, "utf8")).resolves.toBe(
      [
        `${exactBun}\t--version\t${env.PATH}`,
        `${exactBun}\trun turbo run build\t${bin}${delimiter}${env.PATH}`,
        "",
      ].join("\n"),
    );
    await expect(readBuildIdentity(root)).resolves.not.toBe(identity);

    await writeFile(join(root, "tracked.txt"), "stale-again\n");
    await writeFile(bunLog, "");
    await ensureRepositoryBuild(root, { env, nodeVersion: "v24.19.0" });
    await expect(readFile(bunLog, "utf8")).resolves.toBe(
      [
        `${exactBun}\t--version\t${env.PATH}`,
        `${exactBun}\trun turbo run build\t${bin}${delimiter}${env.PATH}`,
        "",
      ].join("\n"),
    );
  });

  it("preserves an existing binary when source toolchain admission rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-binary-admission-"));
    roots.push(root);
    const outputPath = join(root, "station", "dist", "bin", "stn");
    const bin = join(root, "tools");
    await mkdir(dirname(outputPath), { recursive: true });
    await mkdir(bin);
    await writeFile(outputPath, "working-binary\n");
    await writeFile(
      join(bin, "bun"),
      "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '1.4.0\\n'; fi\n",
      { mode: 0o755 },
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "bun@1.4.0", engines: { node: ">=24.2 <25" } }),
    );
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };

    await expect(
      checkBuildToolchain(root, { env, nodeVersion: "v24.19.0" }),
    ).resolves.toMatchObject({ bunExecutable: await realpath(join(bin, "bun")) });
    await expect(
      removeBinaryOutputAfterSourceAdmission(outputPath, () =>
        checkBuildToolchain(root, { env, nodeVersion: "v22.14.0" }),
      ),
    ).rejects.toThrow("Station requires Node >=24.2 <25; found v22.14.0.");
    await expect(readFile(outputPath, "utf8")).resolves.toBe("working-binary\n");

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ packageManager: "bun@1.4.0", engines: { node: "^24.2.0" } }),
    );
    await expect(
      removeBinaryOutputAfterSourceAdmission(outputPath, () =>
        checkBuildToolchain(root, { env, nodeVersion: "v24.19.0" }),
      ),
    ).rejects.toThrow("Root package.json must declare a supported Node engine; found ^24.2.0.");
    await expect(readFile(outputPath, "utf8")).resolves.toBe("working-binary\n");
  });

  it("keeps nested binary-build dispatch on the exact validated Bun executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "station-bun-locator-"));
    roots.push(root);
    const runtimeBin = join(root, "runtime", "bun", "bin");
    const locatorBin = join(root, "runtime", "node_modules", ".bin");
    const hostileBin = join(root, "hostile-bin");
    const exactBun = join(runtimeBin, "bun.exe");
    const hostileLog = join(root, "hostile.log");
    await Promise.all([
      mkdir(runtimeBin, { recursive: true }),
      mkdir(locatorBin, { recursive: true }),
      mkdir(hostileBin, { recursive: true }),
    ]);
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "bun@1.4.0" }));
    await writeFile(
      exactBun,
      [
        "#!/bin/sh",
        "set -eu",
        'if [ "$1" = "--version" ]; then printf \'1.4.0\\n\'; exit 0; fi',
        'if [ "$1" = "run" ]; then shift; exec "$@"; fi',
        "exit 64",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await symlink(exactBun, join(locatorBin, "bun"));
    await writeFile(
      join(hostileBin, "bun"),
      [
        "#!/bin/sh",
        "printf 'invoked\\n' >> \"$STATION_HOSTILE_BUN_LOG\"",
        'if [ "$1" = "--version" ]; then printf \'1.3.14\\n\'; fi',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const environment = {
      ...process.env,
      PATH: `${hostileBin}${delimiter}${locatorBin}`,
      STATION_HOSTILE_BUN_LOG: hostileLog,
    };
    const runtime = await resolveAndCheckBunVersion(root, {
      executable: exactBun,
      env: environment,
      cwd: root,
    });

    const nestedVersion = await runWithBunExecutable(
      runtime,
      ["run", "bun", "--version"],
      root,
      async (command, args, cwd, env) =>
        execFileSync(command, args, { cwd, env, encoding: "utf8" }),
      environment,
    );

    expect(runtime).toMatchObject({
      executable: await realpath(exactBun),
      locatorDirectory: locatorBin,
    });
    expect(nestedVersion).toBe("1.4.0\n");
    await expect(readFile(hostileLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes the stable identity after an injected build succeeds", async () => {
    const root = await createRepository();
    roots.push(root);
    const identity = await computeBuildIdentity(root);
    await publishBuildIdentity("f".repeat(64), root);

    await buildWithIdentity(root, async () => {
      await expect(readBuildIdentity(root)).rejects.toMatchObject({ code: "ENOENT" });
    });

    await expect(readBuildIdentity(root)).resolves.toBe(identity);
    await expect(verifyBuildIdentity(identity, root)).resolves.toBe(true);
  });

  it("removes the identity when inputs drift during an injected build", async () => {
    const root = await createRepository();
    roots.push(root);
    const identity = await computeBuildIdentity(root);
    await publishBuildIdentity("f".repeat(64), root);

    await expect(
      buildWithIdentity(root, () => writeFile(join(root, "tracked.txt"), "changed\n")),
    ).rejects.toThrow("build inputs changed");

    await expect(computeBuildIdentity(root)).resolves.not.toBe(identity);
    await expect(readBuildIdentity(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a stale identity when an injected build fails", async () => {
    const root = await createRepository();
    roots.push(root);
    const failure = new Error("injected build failure");
    await publishBuildIdentity("f".repeat(64), root);

    await expect(
      buildWithIdentity(root, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    await expect(readBuildIdentity(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates spawned build children from a linked-worktree Git environment", async () => {
    const victim = await createRepository();
    const fixture = await createRepository();
    const victimLinked = `${victim}-linked`;
    const fixtureLinked = `${fixture}-linked`;
    roots.push(victim, fixture, victimLinked, fixtureLinked);
    git(victim, ["branch", "victim-linked"]);
    git(victim, ["worktree", "add", victimLinked, "victim-linked"]);

    const before = {
      config: await readFile(join(victim, ".git", "config"), "utf8"),
      head: gitOutput(victimLinked, ["rev-parse", "HEAD"]),
      status: gitOutput(victimLinked, ["status", "--porcelain=v2", "--branch"]),
      worktrees: gitOutput(victim, ["worktree", "list", "--porcelain"]),
    };
    const hostileGitDir = gitOutput(victimLinked, ["rev-parse", "--absolute-git-dir"]).trim();
    const childScript = `
      const { execFileSync } = require("node:child_process");
      const linked = process.argv[1];
      execFileSync("git", ["config", "--local", "station.fixture", "isolated"]);
      execFileSync("git", ["commit", "--allow-empty", "-m", "fixture child"]);
      execFileSync("git", ["worktree", "add", "-b", "fixture-child", linked]);
    `;

    await runBuildChild(process.execPath, ["-e", childScript, fixtureLinked], fixture, {
      ...environmentWithoutGitLocals(),
      GIT_DIR: hostileGitDir,
      GIT_WORK_TREE: victimLinked,
    });

    await expect(readFile(join(victim, ".git", "config"), "utf8")).resolves.toBe(before.config);
    expect(gitOutput(victimLinked, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(gitOutput(victimLinked, ["status", "--porcelain=v2", "--branch"])).toBe(before.status);
    expect(gitOutput(victim, ["worktree", "list", "--porcelain"])).toBe(before.worktrees);
    expect(gitOutput(fixture, ["config", "--local", "--get", "station.fixture"]).trim()).toBe(
      "isolated",
    );
  });
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "station-build-identity-"));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "station@example.invalid"]);
  git(root, ["config", "user.name", "Station Test"]);
  await writeFile(join(root, ".gitignore"), "dist/\nignored.txt\n");
  await writeFile(join(root, "tracked.txt"), "tracked\n");
  await mkdir(join(root, "packages", "example", "dist"), { recursive: true });
  await writeFile(
    join(root, "packages", "example", "package.json"),
    '{"name":"@station/example","scripts":{"build":"tsc"}}\n',
  );
  await mkdir(join(root, "packages", "example", "test"), { recursive: true });
  await writeFile(join(root, "packages", "example", "test", "value.test.ts"), "tracked\n");
  await writeFile(
    join(root, "packages", "example", "dist", "index.js"),
    "export const build = 'current';\n",
  );
  git(root, [
    "add",
    ".gitignore",
    "tracked.txt",
    "packages/example/package.json",
    "packages/example/test/value.test.ts",
  ]);
  git(root, ["commit", "--quiet", "-m", "initial"]);
  return root;
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    env: environmentWithoutGitLocals(),
    stdio: "ignore",
  });
}

function gitOutput(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    env: environmentWithoutGitLocals(),
    encoding: "utf8",
  });
}
