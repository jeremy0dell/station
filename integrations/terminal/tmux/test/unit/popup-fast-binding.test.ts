import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManagedFastPopupRunShellCommand } from "../../src/popup";
import {
  buildNormalPopupRoute,
  buildPopupActiveClaim,
  parseNormalPopupRoute,
  parsePopupActiveClaim,
} from "../../src/popup/fastProtocol";

const registrationNonce = "11".repeat(16);
const actionNonce = "22".repeat(16);
const signature = "v1:'/opt/station/bin/stn' --config '/tmp/missing.toml' tui --popup --persistent";
const fixtureRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { force: true, recursive: true })));
  fixtureRoots.clear();
});

type FakeState = {
  actionExit?: number;
  activeClient?: string;
  casMisses?: number;
  claim?: string;
  clientName: string;
  clientPid: number;
  clientSession: string;
  devCommand?: string;
  devOwner?: string;
  devRoot?: string;
  devSession?: string;
  fallbackExit?: number;
  focusClient?: string;
  lease: string;
  root: string;
  route: string;
  sessionSignature: string;
  snapshotExit?: number;
};

describe("managed tmux popup fast binding", () => {
  it("strictly parses versioned routes and claims", () => {
    const route = buildNormalPopupRoute({
      registrationNonce,
      root: "/opt/station/bin",
      sessionName: "_station-ui",
      signature,
    });
    expect(parseNormalPopupRoute(route)).toMatchObject({
      kind: "normal",
      registrationNonce,
    });
    expect(parseNormalPopupRoute(`${route}.extra`)).toBeUndefined();
    expect(parseNormalPopupRoute(route.replace("v1.n", "v1.d"))).toBeUndefined();
    expect(parseNormalPopupRoute(route.replace(registrationNonce, "A".repeat(32)))).toBeUndefined();

    const claim = buildPopupActiveClaim({
      actionNonce,
      clientName: "/dev/ttys001",
      clientPid: 1234,
      registrationNonce,
      state: "open",
    });
    expect(parsePopupActiveClaim(claim)).toEqual({
      actionNonce,
      clientName: "/dev/ttys001",
      clientPid: 1234,
      registrationNonce,
      state: "open",
    });
    expect(parsePopupActiveClaim(`${claim}.extra`)).toBeUndefined();
    expect(parsePopupActiveClaim(claim.replace("/dev/ttys001", "bad name"))).toBeUndefined();
    expect(parsePopupActiveClaim(claim.replace(".1234.", ".0."))).toBeUndefined();
  });

  it("opens in exactly one snapshot and one atomic action", async () => {
    const fixture = await createFixture();
    const result = await runBinding(fixture);

    expect(result).toEqual({ code: 0, stderr: "", stdout: "" });
    const calls = await fixture.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args.slice(0, 4)).toEqual(["display-message", "-p", "-t", "_station-ui:"]);
    expect(calls[0]?.args.at(-1)).not.toContain("#{client_");
    expect(calls[1]?.args.slice(0, 4)).toEqual(["if-shell", "-F", "-t", "_station-ui:"]);
    const action = calls[1]?.args.at(-2) ?? "";
    const claim = /active_claim (v1\.open\.[^ ;]+)/.exec(action)?.[1];
    expect(claim).toBeDefined();
    expect(action).toContain("display-popup -c /dev/ttys001");
    expect(action).toContain(
      `if-shell -F '#{==:#{@station_popup_active_claim},${claim}}' 'set-option -gq -u @station_popup_active_claim ; if-shell -F "#{==:#{@station_popup_client},/dev/ttys001}" "set-option -gq -u @station_popup_client" ; if-shell -F "#{==:#{@station_popup_focus_client},/dev/ttys001}" "set-option -gq -u @station_popup_focus_client"'`,
    );
    expect(await fixture.fallbackCalls()).toEqual([]);
  });

  it("closes the same client without reopening", async () => {
    const fixture = await createFixture({
      activeClient: "/dev/ttys001",
      claim: popupClaim("open", 1234, "/dev/ttys001"),
      focusClient: "/dev/ttys001",
    });
    await expect(runBinding(fixture)).resolves.toMatchObject({ code: 0 });

    const action = (await fixture.calls())[1]?.args.at(-2) ?? "";
    expect(action).toContain("v1.closing.");
    expect(action).toContain("display-popup -c /dev/ttys001 -C");
    expect(action.match(/display-popup/g)).toHaveLength(1);
  });

  it("closes the recorded outer client from a nested UI client", async () => {
    const fixture = await createFixture({
      activeClient: "/dev/ttys001",
      claim: popupClaim("open", 1234, "/dev/ttys001"),
      clientName: "/dev/ttys099",
      clientPid: 9999,
      clientSession: "_station-ui",
      focusClient: "/dev/ttys001",
    });
    await expect(runBinding(fixture)).resolves.toMatchObject({ code: 0 });

    const action = (await fixture.calls())[1]?.args.at(-2) ?? "";
    expect(action).toContain("display-popup -c /dev/ttys001 -C");
    expect(action).not.toContain("display-popup -c /dev/ttys099 -w");
  });

  it("replaces a cross-client claim before closing and reopening", async () => {
    const fixture = await createFixture({
      activeClient: "/dev/ttys001",
      claim: popupClaim("open", 1234, "/dev/ttys001"),
      clientName: "/dev/ttys002",
      clientPid: 5678,
      clientSession: "other",
      focusClient: "/dev/ttys001",
    });
    await expect(runBinding(fixture)).resolves.toMatchObject({ code: 0 });

    const action = (await fixture.calls())[1]?.args.at(-2) ?? "";
    expect(action.indexOf("set-option -gq @station_popup_active_claim v1.open.")).toBeLessThan(
      action.indexOf("display-popup -c /dev/ttys001 -C"),
    );
    expect(action).toContain("display-popup -c /dev/ttys002 -w 50% -h 50%");
  });

  it("forces fallback for live dev state but ignores a provably dead dev owner", async () => {
    const live = await createFixture({
      devCommand: "node dev-ui",
      devOwner: `${process.pid}:test`,
      devRoot: "/worktree",
      devSession: "_station-ui-dev",
    });
    await expect(runBinding(live)).resolves.toMatchObject({ code: 0 });
    expect(await live.calls()).toHaveLength(1);
    expect(await live.fallbackCalls()).toEqual(["/dev/ttys001"]);

    const signalDenied = await createFixture({
      devCommand: "node dev-ui",
      devOwner: "1:test",
      devRoot: "/worktree",
      devSession: "_station-ui-dev",
    });
    await expect(runBinding(signalDenied)).resolves.toMatchObject({ code: 0 });
    expect(await signalDenied.calls()).toHaveLength(1);
    expect(await signalDenied.fallbackCalls()).toEqual(["/dev/ttys001"]);

    const stale = await createFixture({
      devCommand: "node dev-ui",
      devOwner: "999999999:test",
      devRoot: "/worktree",
      devSession: "_station-ui-dev",
    });
    await expect(runBinding(stale)).resolves.toMatchObject({ code: 0 });
    expect(await stale.calls()).toHaveLength(2);
    expect(await stale.fallbackCalls()).toEqual([]);
  });

  it("passes the outer binding caller to first-use fallback when the hidden session is missing", async () => {
    const fixture = await createFixture({ snapshotExit: 1 });
    await expect(runBinding(fixture)).resolves.toEqual({ code: 0, stderr: "", stdout: "" });
    expect(await fixture.fallbackCalls()).toEqual(["/dev/ttys001"]);
    expect(await fixture.calls()).toHaveLength(1);
  });

  it("falls back from a valid route with a different configured UI signature", async () => {
    const configPath = "/tmp/station config #{session_name}/config.toml";
    const fixture = await createFixture({}, "managed bin", configPath, "/tmp/previous-config.toml");

    await expect(runBinding(fixture)).resolves.toMatchObject({ code: 0 });
    expect(await fixture.fallbackConfigCalls()).toEqual([`${configPath}\t--config\t${configPath}`]);
  });

  it("falls back on legacy, mixed-version, and hostile state", async () => {
    const legacy = await createFixture({ activeClient: "/dev/ttys001" });
    await expect(runBinding(legacy)).resolves.toMatchObject({ code: 0 });
    expect(await legacy.fallbackCalls()).toEqual(["/dev/ttys001"]);

    const mixed = await createFixture({
      activeClient: "/dev/ttys001",
      claim: popupClaim("open", 1234, "/dev/ttys001").replace(registrationNonce, "33".repeat(16)),
      focusClient: "/dev/ttys001",
    });
    await expect(runBinding(mixed)).resolves.toMatchObject({ code: 0 });
    expect(await mixed.fallbackCalls()).toEqual(["/dev/ttys001"]);

    const hostile = await createFixture({ route: "v1.n.$(touch /tmp/nope)" });
    await expect(runBinding(hostile)).resolves.toEqual({ code: 0, stderr: "", stdout: "" });
    expect(await hostile.fallbackCalls()).toEqual(["/dev/ttys001"]);

    const leadingZeroPid = await createFixture();
    const state = JSON.parse(await readFile(leadingZeroPid.statePath, "utf8")) as Record<
      string,
      unknown
    >;
    state.clientPid = "01234";
    await writeFile(leadingZeroPid.statePath, JSON.stringify(state));
    await expect(runBinding(leadingZeroPid)).resolves.toMatchObject({ code: 0 });
    expect(await leadingZeroPid.fallbackCalls()).toEqual(["/dev/ttys001"]);
  }, 15_000);

  it("retries one CAS miss and falls back on persistent contention", async () => {
    const retry = await createFixture({ casMisses: 1 });
    await expect(runBinding(retry)).resolves.toMatchObject({ code: 0 });
    expect((await retry.calls()).map((call) => call.args[0])).toEqual([
      "display-message",
      "if-shell",
      "display-message",
      "if-shell",
    ]);
    expect(await retry.fallbackCalls()).toEqual([]);

    const contended = await createFixture({ casMisses: 2 });
    await expect(runBinding(contended)).resolves.toMatchObject({ code: 0 });
    expect(await contended.fallbackCalls()).toEqual(["/dev/ttys001"]);
  });

  it("cleans only its exact claim after an action failure before fallback", async () => {
    const fixture = await createFixture({ actionExit: 1 });
    await expect(runBinding(fixture)).resolves.toMatchObject({ code: 0 });

    const calls = await fixture.calls();
    expect(calls).toHaveLength(3);
    expect(calls[2]?.args[4]).toMatch(/^#\{==:#\{@station_popup_active_claim\},v1\.open\./);
    expect(await fixture.fallbackCalls()).toEqual(["/dev/ttys001"]);
  });

  it("normalizes action and fallback exits 0 and 129, and hides fallback failure output", async () => {
    for (const actionExit of [0, 129]) {
      const fixture = await createFixture({ actionExit });
      await expect(runBinding(fixture)).resolves.toEqual({ code: 0, stderr: "", stdout: "" });
      expect(await fixture.fallbackCalls()).toEqual([]);
    }

    for (const fallbackExit of [0, 129]) {
      const fixture = await createFixture({ fallbackExit, route: "malformed" });
      await expect(runBinding(fixture)).resolves.toEqual({ code: 0, stderr: "", stdout: "" });
    }

    const failed = await createFixture({ fallbackExit: 1, route: "malformed" });
    await expect(runBinding(failed)).resolves.toEqual({ code: 0, stderr: "", stdout: "" });
    expect((await failed.calls()).at(-1)?.args).toEqual([
      "display-message",
      "-d",
      "3000",
      "Station popup failed; run stn popup for details",
    ]);
  }, 15_000);

  it("quotes hostile installation paths, escapes tmux formats, and produces valid POSIX shell", async () => {
    const fixture = await createFixture({}, "station's #{session_name} managed bin");
    expect(fixture.command).not.toMatch(/[\r\n]/);
    expect(fixture.command).toContain("##{session_name}");
    const syntax = await runShell(fixture.command, ["-n", "-c"]);
    expect(syntax).toEqual({ code: 0, stderr: "", stdout: "" });
    await expect(runBinding(fixture)).resolves.toEqual({ code: 0, stderr: "", stdout: "" });
    const action = (await fixture.calls())[1]?.args.at(-2) ?? "";
    expect(action).toContain("##{session_name}");
    expect(action).not.toContain("station's #{session_name} managed bin/tmux fake");
  });

  it("rejects relative or control-character config paths", () => {
    const options = {
      fallbackAlias: "/opt/station/stn-tmux-popup",
      installedRoot: "/opt/station",
      tmuxCommand: "/opt/homebrew/bin/tmux",
    };
    for (const configPath of [
      "relative.toml",
      "/tmp/config\0.toml",
      "/tmp/config\r.toml",
      "/tmp/config\n.toml",
    ]) {
      expect(() => buildManagedFastPopupRunShellCommand({ ...options, configPath })).toThrow(
        "safe absolute config path",
      );
    }
  });
});

type Fixture = {
  calls: () => Promise<Array<{ args: string[] }>>;
  command: string;
  fallbackCalls: () => Promise<string[]>;
  fallbackConfigCalls: () => Promise<string[]>;
  statePath: string;
};

async function createFixture(
  overrides: Partial<FakeState> = {},
  directoryName = "managed bin",
  configPath?: string,
  registeredConfigPath = configPath,
): Promise<Fixture> {
  const tempRoot = await mkdtemp(join(tmpdir(), "station-fast-binding-"));
  fixtureRoots.add(tempRoot);
  const installedRoot = join(tempRoot, directoryName);
  const tmuxCommand = join(installedRoot, "tmux fake");
  const fallbackAlias = join(installedRoot, "stn-tmux-popup");
  const statePath = join(tempRoot, "state.json");
  const logPath = join(tempRoot, "tmux.jsonl");
  const fallbackLogPath = join(tempRoot, "fallback.log");
  const fallbackConfigLogPath = join(tempRoot, "fallback-config.log");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(installedRoot, { recursive: true }));
  const registeredSignature = fixturePopupSignature(installedRoot, registeredConfigPath);
  const route = buildNormalPopupRoute({
    registrationNonce,
    root: installedRoot,
    sessionName: "_station-ui",
    signature: registeredSignature,
  });
  const state: FakeState = {
    clientName: "/dev/ttys001",
    clientPid: 1234,
    clientSession: "outer",
    lease: route,
    root: installedRoot,
    route,
    sessionSignature: registeredSignature,
    ...overrides,
  };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(logPath, "");
  await writeFile(fallbackLogPath, "");
  await writeFile(fallbackConfigLogPath, "");
  await writeFile(
    tmuxCommand,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const statePath = process.env.FAKE_TMUX_STATE;
const logPath = process.env.FAKE_TMUX_LOG;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify({ args }) + "\\n");
if (args[0] === "display-message" && args[1] === "-p" && args[2] === "-t") {
  if (state.snapshotExit !== undefined) process.exit(state.snapshotExit);
  const fields = [
    state.route, state.lease, state.claim ?? "", state.sessionSignature,
    "_station-ui", state.sessionSignature, state.root,
    state.activeClient ?? "", state.focusClient ?? "",
    state.devSession ?? "", state.devCommand ?? "", state.devOwner ?? "", state.devRoot ?? "",
    "v1",
  ];
  process.stdout.write(fields.join(String.fromCharCode(31)) + "\\n");
  process.exit(0);
}
if (args[0] === "if-shell" && args.at(-1) === "display-message -p STATION_POPUP_CAS_MISS") {
  if ((state.casMisses ?? 0) > 0) {
    state.casMisses -= 1;
    writeFileSync(statePath, JSON.stringify(state));
    process.stdout.write("STATION_POPUP_CAS_MISS\\n");
    process.exit(0);
  }
  process.exit(state.actionExit ?? 0);
}
process.exit(0);
`,
  );
  await writeFile(
    fallbackAlias,
    `#!/bin/sh
printf '%s\\n' "\${STATION_FOCUS_CLIENT_ID:-}" >> ${shellLiteral(fallbackLogPath)}
printf '%s\\t%s\\t%s\\n' "\${STATION_CONFIG_PATH:-}" "\${1:-}" "\${2:-}" >> ${shellLiteral(fallbackConfigLogPath)}
printf 'fallback output that must stay hidden\\n'
printf 'fallback error that must stay hidden\\n' >&2
exit \${FAKE_FALLBACK_EXIT:-0}
`,
  );
  await chmod(tmuxCommand, 0o700);
  await chmod(fallbackAlias, 0o700);
  const commandOptions: Parameters<typeof buildManagedFastPopupRunShellCommand>[0] = {
    fallbackAlias,
    installedRoot,
    tmuxCommand,
  };
  if (configPath !== undefined) commandOptions.configPath = configPath;
  return {
    calls: async () => readJsonLines(logPath),
    command: buildManagedFastPopupRunShellCommand(commandOptions),
    fallbackCalls: async () => readLines(fallbackLogPath),
    fallbackConfigCalls: async () => readLines(fallbackConfigLogPath),
    statePath,
  };
}

function fixturePopupSignature(installedRoot: string, configPath: string | undefined): string {
  return `v1:${[
    shellLiteral(join(installedRoot, "stn")),
    ...(configPath === undefined ? [] : ["--config", shellLiteral(configPath)]),
    "tui",
    "--popup",
    "--persistent",
  ].join(" ")}`;
}

function popupClaim(state: "closing" | "open", clientPid: number, clientName: string): string {
  return buildPopupActiveClaim({
    actionNonce,
    clientName,
    clientPid,
    registrationNonce,
    state,
  });
}

async function runBinding(
  fixture: Fixture,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as FakeState;
  const expanded = expandTmuxBindingFormats(fixture.command, state);
  return runShell(expanded, ["-c"], {
    FAKE_FALLBACK_EXIT: String(state.fallbackExit ?? 0),
    FAKE_TMUX_LOG: fixture.statePath.replace("state.json", "tmux.jsonl"),
    FAKE_TMUX_STATE: fixture.statePath,
  });
}

function expandTmuxBindingFormats(command: string, state: FakeState): string {
  const formats = [
    ["#{q:client_name}", state.clientName],
    ["#{client_pid}", String(state.clientPid)],
    ["#{q:client_session}", state.clientSession],
  ] as const;
  let expanded = "";
  for (let index = 0; index < command.length; index += 1) {
    if (command.startsWith("##", index)) {
      expanded += "#";
      index += 1;
      continue;
    }
    const format = formats.find(([token]) => command.startsWith(token, index));
    if (format === undefined) {
      expanded += command[index];
      continue;
    }
    expanded += format[1];
    index += format[0].length - 1;
  }
  return expanded;
}

async function runShell(
  command: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const child = spawn("/bin/sh", [...args, command], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) =>
      resolve({
        code,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }),
    );
  });
}

async function readJsonLines(path: string): Promise<Array<{ args: string[] }>> {
  return (await readLines(path)).map((line) => JSON.parse(line) as { args: string[] });
}

async function readLines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).split(/\r?\n/).filter((line) => line.length > 0);
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
