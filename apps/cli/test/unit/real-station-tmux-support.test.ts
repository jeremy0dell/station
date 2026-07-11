import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealE2eEnvironment } from "../../../../tests/support/real-station/env.js";

const execFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execFile(file, args, options);
    callback(null, "", "");
  },
  spawn: vi.fn(),
}));

import { startStationTuiInTmux } from "../../../../tests/support/real-station/tmux.js";

describe("real Station tmux support", () => {
  beforeEach(() => {
    execFile.mockClear();
  });

  it("launches the dashboard entry in the captured tmux viewport", async () => {
    const env: RealE2eEnvironment = {
      repoRoot: "/repo",
      stationBin: "/repo/bin/stn",
      stationIngressBin: "/repo/bin/stn-ingress",
      tmuxBin: "/opt/homebrew/bin/tmux",
    };

    await startStationTuiInTmux({
      env,
      configPath: "/tmp/station config.toml",
      sessionName: "station-real-tui",
    });

    expect(execFile).toHaveBeenCalledWith(
      "/opt/homebrew/bin/tmux",
      [
        "new-session",
        "-d",
        "-s",
        "station-real-tui",
        "'/repo/bin/stn' --config '/tmp/station config.toml' tui --popup",
      ],
      { timeout: 10_000 },
    );
  });
});
