import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeRealStationConfig } from "../../../../tests/support/real-station/config.js";
import type { RealE2eEnvironment } from "../../../../tests/support/real-station/env.js";
import type { RealTempRepo } from "../../../../tests/support/real-station/repo.js";

describe("real Station config support", () => {
  let root: string | undefined;
  const endpointRoots: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
    await Promise.all(
      endpointRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("creates private Observer directories and writes scripted harness config", async () => {
    root = await mkdtemp(join(tmpdir(), "station-real-config-support-"));
    const tmuxBin = join(root, "tmux path's");
    await writeFile(
      tmuxBin,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: These are shell parameter expansions.
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$0.args"\nprintf \'%s\\n\' "${TMUX-unset}" "${TMUX_PANE-unset}" > "$0.env"\n',
      "utf8",
    );
    await chmod(tmuxBin, 0o700);
    vi.stubEnv("TMUX", "/ambient/hostile.sock,99,0");
    vi.stubEnv("TMUX_PANE", "%99");
    const repo: RealTempRepo = {
      root,
      repoPath: join(root, "repo"),
      realE2eDir: join(root, "repo", ".station-real-e2e"),
      baseBranch: "main",
      cleanup: async () => undefined,
    };
    const env: RealE2eEnvironment = {
      repoRoot: "/station",
      stationBin: "/station/bin/stn",
      stationIngressBin: "/station/bin/stn-ingress",
      tmuxBin,
      worktrunkBin: "/usr/local/bin/wt",
    };

    const fixture = await writeRealStationConfig({
      env,
      repo,
      harnessProvider: "scripted",
      scriptedCommand: "/usr/local/bin/node",
    });
    endpointRoots.push(fixture.tmuxEndpoint.rootPath);

    await expect(directoryMode(fixture.stateDir)).resolves.toBe(0o700);
    await expect(directoryMode(join(root, "run"))).resolves.toBe(0o700);
    await expect(directoryMode(fixture.tmuxEndpoint.rootPath)).resolves.toBe(0o700);
    await expect(directoryMode(fixture.tmuxEndpoint.wrapperPath)).resolves.toBe(0o700);
    await expect(readFile(fixture.tmuxEndpoint.wrapperPath, "utf8")).resolves.toBe(
      `#!/bin/sh\nexec '${tmuxBin.replaceAll("'", "'\\''")}' -f /dev/null "$@"\n`,
    );
    await expect(readFile(`${tmuxBin}.args`, "utf8")).resolves.toBe(
      `-f\n/dev/null\n-S\n${fixture.tmuxEndpoint.socketPath}\nnew-session\n-d\n-s\n_station-real-endpoint\nsleep 86400\n`,
    );
    await expect(readFile(`${tmuxBin}.env`, "utf8")).resolves.toBe("unset\nunset\n");
    const config = await readFile(fixture.configPath, "utf8");
    expect(config).toContain(
      `[terminal.tmux]\ncommand = ${JSON.stringify(fixture.tmuxEndpoint.wrapperPath)}\nworkbench_socket_path = ${JSON.stringify(fixture.tmuxEndpoint.socketPath)}`,
    );
    expect(config).toContain('[harness.scripted]\nenabled = true\ncommand = "/usr/local/bin/node"');

    const second = await writeRealStationConfig({
      env,
      repo,
      harnessProvider: "scripted",
      scriptedCommand: "/usr/local/bin/node",
      tmuxSession: "station-real-second",
    });
    endpointRoots.push(second.tmuxEndpoint.rootPath);
    expect(second.tmuxEndpoint.rootPath).not.toBe(fixture.tmuxEndpoint.rootPath);
  });
});

const directoryMode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
