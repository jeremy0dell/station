import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTempState, writeConfigToml } from "../support/temp-projects";

const cliPath = fileURLToPath(new URL("../../apps/cli/dist/main.js", import.meta.url));

describe("session migration process boundaries", () => {
  it("keeps --require-running snapshot planning free of runtime creation", async () => {
    const fixture = await createTempState();
    const config = {
      ...fixture.config,
      observer: {
        stateDir: fixture.stateDir,
        socketPath: fixture.socketPath,
      },
    };
    const configPath = await writeConfigToml(fixture.root, config);

    try {
      await expect(
        new Promise((resolveRun, rejectRun) => {
          execFile(
            process.execPath,
            [cliPath, "--config", configPath, "snapshot", "--json", "--require-running"],
            { encoding: "utf8" },
            (error, stdout, stderr) => {
              if (error === null) resolveRun({ stdout, stderr });
              else rejectRun(error);
            },
          );
        }),
      ).rejects.toThrow();
      await expect(access(fixture.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(fixture.stateDir, "observer.sqlite"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
