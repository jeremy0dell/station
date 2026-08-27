import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealE2eEnvironment } from "../../../../tests/support/real-station/env.js";

const execFileAsync = vi.hoisted(() => vi.fn());
const spawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => {
  const execFile = (): never => {
    throw new Error("Unexpected callback-form execFile invocation.");
  };
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: (file: string, args: string[], options: unknown) => execFileAsync(file, args, options),
  });
  return { execFile, spawn: (...args: unknown[]) => spawn(...args) };
});

import {
  closeRealTmuxEndpoint,
  createRealTmuxEndpoint,
  displayStationPopupAndSendKey,
  killTmuxSession,
  launchNativeStationInTmux,
  type RealTmuxEndpoint,
  startAttachedTmuxPtyClient,
  startStationTuiInTmux,
} from "../../../../tests/support/real-station/tmux.js";

describe("real Station tmux support", () => {
  const roots: string[] = [];

  beforeEach(() => {
    execFileAsync.mockReset();
    spawn.mockReset();
    mockTmux(() => succeed());
    process.env.TMUX = "/ambient,1,0";
    process.env.TMUX_PANE = "%99";
  });

  afterEach(async () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("launches the dashboard through the exact private endpoint", async () => {
    const endpoint = testEndpoint();
    await startStationTuiInTmux({
      env: TEST_ENVIRONMENT,
      endpoint,
      configPath: "/tmp/station config.toml",
      sessionName: "station-real-tui",
    });
    const [file, args, options] = execFileAsync.mock.calls[0] as DirectCall;
    expect(file).toBe(endpoint.wrapperPath);
    expect(args).toEqual([
      "-S",
      endpoint.socketPath,
      "new-session",
      "-d",
      "-s",
      "station-real-tui",
      "'/repo/bin/stn' --config '/tmp/station config.toml' tui --popup",
    ]);
    expect(options.env).not.toHaveProperty("TMUX");
    expect(options.env).not.toHaveProperty("TMUX_PANE");
  });

  it("uses the private endpoint for spawned clients and retains spawn failure", async () => {
    const endpoint = testEndpoint();
    spawn.mockReturnValue(fakeChild());
    let polls = 0;
    mockTmux((args) => {
      if (!args.includes("list-clients")) return succeed();
      return succeed(++polls === 1 ? BASELINE_CLIENTS : MULTIPLE_CLIENTS);
    });

    await expect(
      startAttachedTmuxPtyClient({ endpoint, sessionName: "workbench" }),
    ).rejects.toMatchObject(failureErrors('"name":"new-b"'));
    const spawnedArgs = spawn.mock.calls[0]?.[1] as string[];
    const spawnedOptions = spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(spawnedArgs.slice(4, 7)).toEqual([endpoint.wrapperPath, "-S", endpoint.socketPath]);
    expect(spawnedOptions.env).not.toHaveProperty("TMUX");
    expect(spawnedOptions.env).not.toHaveProperty("TMUX_PANE");

    spawn.mockImplementation(() => fakeChild(undefined, null, new Error("spawn ENOENT")));
    mockTmux((args) => succeed(args.includes("list-clients") ? BASELINE_CLIENTS : ""));
    await expect(
      startAttachedTmuxPtyClient({ endpoint, sessionName: "workbench" }),
    ).rejects.toMatchObject(failureErrors("did not expose a process id", "spawn ENOENT"));
  });

  it("retains detach failure and PTY data emitted between exit and close", async () => {
    const endpoint = testEndpoint();
    const child = fakeChild("final-close-evidence");
    const closeEvents = vi.fn();
    child.on("close", closeEvents);
    spawn.mockReturnValue(child);
    let polls = 0;
    mockTmux((args) => {
      if (args.includes("list-clients"))
        return succeed(++polls === 1 ? BASELINE_CLIENTS : ONE_CLIENT);
      if (args.includes("display-message")) return succeed("new\t20\tworkbench\tagent\t%7\n");
      if (args.includes("detach-client")) return fail(1, "detach denied\n");
      return succeed();
    });

    const client = await startAttachedTmuxPtyClient({ endpoint, sessionName: "workbench" });
    const firstClose = client.close();
    const concurrentClose = client.close();
    await expect(firstClose).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining("detach denied") })],
      message: expect.stringContaining("final-close-evidence"),
    });
    await expect(concurrentClose).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
    expect(commandCalls("display-message")).toHaveLength(1);
    expect(commandCalls("detach-client")).toHaveLength(1);
    expect(closeEvents).toHaveBeenCalledOnce();
  });

  it("classifies exact absence, aggregates partial initialization, and retains uncertain roots", async () => {
    const endpoint = testEndpoint();
    mockTmux(() => fail(1, "can't find session: missing\n"));
    await expect(killTmuxSession(endpoint, "missing")).resolves.toBeUndefined();

    mockTmux(() => fail(1, "can't find session: other\n"));
    await expect(killTmuxSession(endpoint, "missing")).rejects.toThrow("other");

    const removed = testEndpoint(await temporaryRoot());
    mockTmux((args) =>
      args.includes("kill-server")
        ? succeed()
        : fail(1, `error connecting to ${removed.socketPath} (No such file or directory)\n`),
    );
    await closeRealTmuxEndpoint(removed);
    await expect(stat(removed.rootPath)).rejects.toMatchObject({ code: "ENOENT" });

    const retained = testEndpoint(await temporaryRoot());
    mockTmux((args) => (args.includes("kill-server") ? succeed() : fail(1, "permission denied\n")));
    await expect(closeRealTmuxEndpoint(retained)).rejects.toThrow("permission denied");
    await expect(stat(retained.rootPath)).resolves.toBeDefined();

    let initializationRoot: string | undefined;
    mockTmux((args, file) => {
      initializationRoot = dirname(file);
      return args.includes("new-session")
        ? fail(1, "initialization failed\n")
        : fail(1, "cleanup failed\n");
    });
    await expect(createRealTmuxEndpoint(TEST_ENVIRONMENT)).rejects.toMatchObject(
      failureErrors("initialization failed", "cleanup failed"),
    );
    if (initializationRoot === undefined) throw new Error("Initialization did not invoke tmux.");
    roots.push(initializationRoot);
    await expect(stat(initializationRoot)).resolves.toBeDefined();
  });

  it("performs zero writes after tuple drift or popup settlement", async () => {
    await expectNoPopupWrite(
      await popupHarness({
        drainOnClose: true,
        views: [CLIENT_VIEW, "new\t20\tworkbench\twrong\t%7\n", CLIENT_VIEW],
      }),
      "before input",
    );
    await expectNoPopupWrite(await popupHarness({ settleOnOpen: true }), "settled");
  });

  it("waits for the current nonced start despite stale popup artifacts", async () => {
    const start = Promise.withResolvers<void>();
    const current = await popupHarness({ startGate: start.promise });
    const oldStartMarker = `${POPUP_START}:${OLD_POPUP_NONCE}`;
    const oldReleasePath = `${current.markerPath}.${OLD_POPUP_NONCE}.release`;
    await writeFile(current.markerPath, `${oldStartMarker}\n`, "utf8");
    await writeFile(oldReleasePath, "release\n", "utf8");
    const opening = current.open();
    await vi.waitFor(() => expect(current.state.startMarker).toBeDefined());
    expect(current.state.startMarker).not.toBe(oldStartMarker);
    expect(current.state.releasePath).not.toBe(oldReleasePath);
    expect(current.write).not.toHaveBeenCalled();
    start.resolve();
    const popup = await opening;
    expect(current.write).toHaveBeenCalledOnce();
    await appendFile(current.markerPath, "child-exit:0\n", "utf8");
    current.settle({ code: 0 });
    await popup.release(true);
    await expect(readFile(current.state.releasePath as string, "utf8")).resolves.toBe("release\n");
  });

  it("writes once and accepts only exact child-zero, empty signal-free 129 evidence", async () => {
    const accepted = await popupHarness();
    const popup = await accepted.open();
    expect(accepted.write).toHaveBeenCalledExactlyOnceWith(Buffer.from("1", "utf8"));
    await appendFile(accepted.markerPath, "child-exit:0\n", "utf8");
    accepted.settle({ code: 129 });
    const release = popup.release(true);
    expect(popup.release(false)).toBe(release);
    await release;

    for (const invalid of [
      { child: "child-exit:1\n", settlement: { code: 0 } },
      { child: "child-exit:0\n", settlement: { code: 129, stderr: "dismissed\n" } },
      { child: "child-exit:0\n", settlement: { code: 129, signal: "SIGTERM" as const } },
    ]) {
      const rejected = await popupHarness();
      const rejectedPopup = await rejected.open();
      await appendFile(rejected.markerPath, invalid.child, "utf8");
      rejected.settle(invalid.settlement);
      await expect(rejectedPopup.release(true)).rejects.toThrow();
    }
  });

  it("closes and drains the exact popup after rejected key delivery", async () => {
    const rejected = await popupHarness(
      { drainOnClose: true },
      vi.fn().mockRejectedValue(new Error("key rejected")),
    );
    await expect(rejected.open()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "key rejected" })],
      message: expect.stringContaining("PTY evidence"),
    });
    expect(rejected.state.closes).toBe(1);
    await expect(readFile(rejected.state.releasePath as string, "utf8")).resolves.toBe("release\n");
  });

  it("kills only a successfully created native session and aggregates cleanup failure", async () => {
    const input = {
      env: TEST_ENVIRONMENT,
      endpoint: testEndpoint(),
      configPath: "/tmp/config.toml",
      observerSocketPath: "/tmp/observer.sock",
      stateDir: "/tmp/state",
      sessionName: "native",
    };
    mockTmux((args) =>
      args.includes("new-session") ? fail(1, "new-session failed\n") : succeed(),
    );
    await expect(launchNativeStationInTmux(input)).rejects.toThrow("new-session failed");
    expect(execFileAsync.mock.calls.some((call) => call[1].includes("kill-session"))).toBe(false);

    execFileAsync.mockClear();
    mockTmux((args) => {
      if (args.includes("new-session")) return succeed();
      if (args.includes("set-option")) return fail(1, "mouse setup failed\n");
      if (args.includes("kill-session")) return fail(1, "native cleanup failed\n");
      return succeed();
    });
    await expect(launchNativeStationInTmux(input)).rejects.toMatchObject(
      failureErrors("mouse setup failed", "native cleanup failed"),
    );
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "station-tmux-unit-"));
    roots.push(root);
    return root;
  }

  async function popupHarness(options: PopupOptions = {}, write = vi.fn(async () => undefined)) {
    const markerPath = join(await temporaryRoot(), "marker");
    const settlement = Promise.withResolvers<ExecResult>();
    const state = {
      closes: 0,
      releasePath: undefined as string | undefined,
      settled: false,
      startMarker: undefined as string | undefined,
    };
    const settle = (result: PopupSettlement): void => {
      if (state.settled) throw new Error("popup settlement repeated");
      state.settled = true;
      if (result.code === 0) settlement.resolve({ stderr: "", stdout: "" });
      else settlement.reject(tmuxError(result.code, result.stderr ?? "", result.signal ?? null));
    };
    let viewIndex = 0;
    mockTmux((args) => {
      if (args.includes("display-message"))
        return succeed(options.views?.[viewIndex++] ?? CLIENT_VIEW);
      if (args.includes("display-popup") && args.includes("-C")) {
        expect(args.slice(2)).toEqual(["display-popup", "-c", "new", "-C"]);
        state.closes += 1;
        if (options.drainOnClose === true && !state.settled) settle({ code: 0 });
        return succeed();
      }
      if (!args.includes("display-popup")) return succeed();
      expect(args.slice(2, 7)).toEqual(["display-popup", "-c", "new", "-t", "workbench:agent.0"]);
      const match = POPUP_START_PATTERN.exec(args.at(-1) ?? "");
      if (match === null) throw new Error("popup invocation did not include its nonce");
      state.startMarker = match[0];
      state.releasePath = `${markerPath}.${match[1]}.release`;
      void Promise.resolve(options.startGate)
        .then(() => writeFile(markerPath, `${state.startMarker}\n`, "utf8"))
        .then(() => {
          if (options.settleOnOpen === true) settle({ code: 0 });
        }, settlement.reject);
      return settlement.promise;
    });
    const client = {
      clientName: "new",
      clientPid: 20,
      processId: 77,
      sessionName: "workbench",
      write,
      outputTail: () => "\nPTY evidence",
      close: async () => undefined,
    };
    const input: Parameters<typeof displayStationPopupAndSendKey>[0] = {
      env: TEST_ENVIRONMENT,
      endpoint: testEndpoint(),
      client,
      configPath: "/tmp/config.toml",
      target: "workbench:agent.0",
      expectedWindowName: "agent",
      expectedPaneId: "%7",
      key: "1",
      markerPath,
      delaySeconds: 0,
    };
    return { markerPath, open: () => displayStationPopupAndSendKey(input), settle, state, write };
  }

  async function expectNoPopupWrite(
    popup: Awaited<ReturnType<typeof popupHarness>>,
    message: string,
  ): Promise<void> {
    await expect(popup.open()).rejects.toMatchObject(failureErrors(message));
    expect(popup.write).not.toHaveBeenCalled();
  }
});

const POPUP_START = "popup-started:new:20:workbench:agent.0";
const POPUP_START_PATTERN = /popup-started:new:20:workbench:agent\.0:([\da-f-]{36})/u;
const OLD_POPUP_NONCE = "11111111-1111-4111-8111-111111111111";
const CLIENT_VIEW = "new\t20\tworkbench\tagent\t%7\n";
const BASELINE_CLIENTS = "old\t10\tworkbench\n";
const ONE_CLIENT = `${BASELINE_CLIENTS}new\t20\tworkbench\n`;
const MULTIPLE_CLIENTS = `${BASELINE_CLIENTS}new-a\t20\tworkbench\nnew-b\t21\tworkbench\n`;

type DirectCall = [string, string[], { env: NodeJS.ProcessEnv }];
type ExecResult = { stderr: string; stdout: string };
type PopupOptions = {
  drainOnClose?: boolean;
  settleOnOpen?: boolean;
  startGate?: Promise<void>;
  views?: string[];
};
type PopupSettlement = { code: number; stderr?: string; signal?: NodeJS.Signals };

function testEndpoint(rootPath = "/private"): RealTmuxEndpoint {
  return {
    rootPath,
    socketPath: join(rootPath, "server.sock"),
    wrapperPath: join(rootPath, "tmux"),
  };
}

const commandCalls = (command: string) =>
  execFileAsync.mock.calls.filter((call) => call[1].includes(command));

const TEST_ENVIRONMENT: RealE2eEnvironment = {
  repoRoot: "/repo",
  stationBin: "/repo/bin/stn",
  stationIngressBin: "/repo/bin/stn-ingress",
  tmuxBin: "/opt/homebrew/bin/tmux",
};

function mockTmux(handler: (args: string[], file: string) => Promise<ExecResult>): void {
  execFileAsync.mockImplementation(
    (file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(args.slice(0, 2)).toEqual(["-S", join(dirname(file), "server.sock")]);
      expect(options.env).not.toHaveProperty("TMUX");
      expect(options.env).not.toHaveProperty("TMUX_PANE");
      return handler(args, file);
    },
  );
}

const fail = (code: number, stderr: string) => Promise.reject(tmuxError(code, stderr));

function tmuxError(code: number, stderr: string, signal: NodeJS.Signals | null = null) {
  return Object.assign(new Error(stderr || `tmux exited ${code}`), {
    code,
    killed: false,
    signal,
    stderr,
    stdout: "",
  });
}

const succeed = (stdout = "", stderr = "") => Promise.resolve({ stderr, stdout });

const failureErrors = (...messages: string[]) => ({
  errors: messages.map((message) =>
    expect.objectContaining({ message: expect.stringContaining(message) }),
  ),
});

function fakeChild(
  finalEvidence?: string,
  pid: number | null = 77,
  spawnFailure?: Error,
): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    kill: vi.fn(),
    pid: pid ?? undefined,
    signalCode: null,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  }) as unknown as ChildProcess;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    child.emit("close", spawnFailure === undefined ? 0 : 1, null);
  };
  child.stdin?.once("finish", () => {
    child.emit("exit", 0, null);
    if (finalEvidence !== undefined) child.stderr?.write(finalEvidence);
    queueMicrotask(close);
  });
  if (spawnFailure !== undefined) {
    queueMicrotask(() => {
      child.emit("error", spawnFailure);
      close();
    });
  }
  return child;
}
