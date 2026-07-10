import { describe, expect, it } from "vitest";
import {
  dispatchSelfExec,
  type ExecutableArgv,
  type SelfExecRunners,
  type SelfExecTarget,
  selfExecArgv,
} from "../../src/selfExec.js";

const COMPILED_TARGETS = [
  { target: "cli", expected: ["/opt/stn"] },
  { target: "observer", expected: ["/opt/stn", "__observer"] },
  { target: "ingress", expected: ["/opt/stn", "__ingress"] },
  { target: "tui", expected: ["/opt/stn", "__tui"] },
  { target: "dashboard", expected: ["/opt/stn", "__dashboard"] },
  { target: "station-host", expected: ["/opt/stn", "__station-host"] },
  { target: "tmux-popup", expected: ["/opt/stn", "__tmux-popup"] },
] as const satisfies readonly {
  target: SelfExecTarget;
  expected: ExecutableArgv;
}[];

const INTERNAL_ROUTES = [
  { token: "__observer", runner: "observer" },
  { token: "__ingress", runner: "ingress" },
  { token: "__tui", runner: "tui" },
  { token: "__dashboard", runner: "dashboard" },
  { token: "__station-host", runner: "stationHost" },
  { token: "__tmux-popup", runner: "tmuxPopup" },
] as const satisfies readonly {
  token: string;
  runner: keyof SelfExecRunners;
}[];

type RunnerCall = {
  runner: keyof SelfExecRunners;
  argv: readonly string[];
};

function createRecordingRunners(): {
  calls: RunnerCall[];
  runners: SelfExecRunners;
} {
  const calls: RunnerCall[] = [];
  const record =
    (runner: keyof SelfExecRunners) =>
    (argv: readonly string[]): void => {
      calls.push({ runner, argv });
    };

  return {
    calls,
    runners: {
      cli: record("cli"),
      observer: record("observer"),
      ingress: record("ingress"),
      tui: record("tui"),
      dashboard: record("dashboard"),
      stationHost: record("stationHost"),
      tmuxPopup: record("tmuxPopup"),
    },
  };
}

describe("selfExecArgv", () => {
  it.each(COMPILED_TARGETS)("returns the original $target tuple in source mode", ({ target }) => {
    const developmentArgv: ExecutableArgv = ["/usr/bin/node", `/repo/${target}.js`, "--fixed"];
    const original = [...developmentArgv];

    const result = selfExecArgv(target, developmentArgv, {
      compiled: false,
      execPath: "/unused/stn",
    });

    expect(result).toBe(developmentArgv);
    expect(developmentArgv).toEqual(original);
  });

  it.each(COMPILED_TARGETS)("returns the compiled $target prefix", ({ target, expected }) => {
    const developmentArgv: ExecutableArgv = ["/usr/bin/node", `/repo/${target}.js`, "--fixed"];
    const original = [...developmentArgv];

    const result = selfExecArgv(target, developmentArgv, {
      compiled: true,
      execPath: "/opt/stn",
    });

    expect(result).toEqual(expected);
    expect(developmentArgv).toEqual(original);
  });
});

describe("dispatchSelfExec", () => {
  it("gives the stn-ingress argv0 route precedence over internal tokens", async () => {
    const argv = ["__observer", "--socket", "/tmp/observer.sock"] as const;
    const { calls, runners } = createRecordingRunners();

    await dispatchSelfExec({ argv0: "/usr/local/bin/stn-ingress", argv }, runners);

    expect(calls).toEqual([{ runner: "ingress", argv }]);
  });

  it("gives the stn-tmux-popup argv0 route precedence over internal tokens", async () => {
    const argv = ["__observer", "--socket", "/tmp/observer.sock"] as const;
    const { calls, runners } = createRecordingRunners();

    await dispatchSelfExec({ argv0: "/usr/local/bin/stn-tmux-popup", argv }, runners);

    expect(calls).toEqual([{ runner: "tmuxPopup", argv }]);
  });

  it.each(INTERNAL_ROUTES)("consumes only $token and invokes only the $runner runner", async ({
    token,
    runner,
  }) => {
    const tail = ["__observer", "--flag", "value"] as const;
    const { calls, runners } = createRecordingRunners();

    await dispatchSelfExec({ argv0: "/usr/local/bin/stn", argv: [token, ...tail] }, runners);

    expect(calls).toEqual([{ runner, argv: tail }]);
  });

  it("routes unknown internal-looking tokens to the CLI unchanged", async () => {
    const argv = ["__scripted", "--flag", "value"] as const;
    const { calls, runners } = createRecordingRunners();

    await dispatchSelfExec({ argv0: "/usr/local/bin/stn", argv }, runners);

    expect(calls).toEqual([{ runner: "cli", argv }]);
  });

  it("routes normal arguments to the CLI unchanged", async () => {
    const argv = ["snapshot", "--json"] as const;
    const { calls, runners } = createRecordingRunners();

    await dispatchSelfExec({ argv0: "/usr/local/bin/stn", argv }, runners);

    expect(calls).toEqual([{ runner: "cli", argv }]);
  });

  it("routes __tmux-popup only to the injected placeholder runner", async () => {
    const argv = ["__tmux-popup", "--toggle"] as const;
    const { calls, runners } = createRecordingRunners();

    await dispatchSelfExec({ argv0: "/usr/local/bin/stn", argv }, runners);

    expect(calls).toEqual([{ runner: "tmuxPopup", argv: ["--toggle"] }]);
  });
});
