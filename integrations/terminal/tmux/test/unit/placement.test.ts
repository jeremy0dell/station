import type { OpenPlacedWorkspaceRequest, TerminalPlacementRequest } from "@station/contracts";
import type { ExternalCommandInput } from "@station/runtime";
import { describe, expect, it } from "vitest";
import { tmuxClientSelectionFormat, tmuxPaneProofFormat } from "../../src/parse.js";
import { TmuxPlacementService } from "../../src/placement/index.js";
import { tmuxCommandResult } from "../support/commands.js";

const now = "2026-08-20T12:00:00.000Z";
const socketPath = "/tmp/station-workbench.sock";
const sourceProof = `${socketPath}\t10\t$1\tcaller\t@1\t%1\t100\t\t`;

const project = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaults: { harness: "codex", terminal: "tmux", layout: "agent-shell" },
  worktrunk: { enabled: true },
};

const worktree = {
  id: "wt_web_feature",
  provider: "worktrunk",
  projectId: "web",
  branch: "feature/login",
  path: "/tmp/station/web/feature",
  state: "exists" as const,
  source: "worktrunk" as const,
  observedAt: now,
};

type FixtureClientSelection = {
  clientName: string;
  clientPid: number;
  sessionId: string;
  windowId: string;
  paneId: string;
};

const sourceClient: FixtureClientSelection = {
  clientName: "/dev/ttys001",
  clientPid: 300,
  sessionId: "$1",
  windowId: "@1",
  paneId: "%1",
};

describe("TmuxPlacementService", () => {
  it("prevalidates the configured detached endpoint before mutation", async () => {
    const fixture = placementFixture();

    await expect(
      fixture.service.validatePlacement({ intent: "detached" }),
    ).resolves.toBeUndefined();
    expect(tmuxArgs(fixture.calls[0] as ExternalCommandInput)).toEqual([
      "has-session",
      "-t",
      "station",
    ]);
  });

  it("mints one-shot sibling authority and creates without selecting or reconfiguring caller state", async () => {
    const fixture = placementFixture();
    const source = await placementSource(fixture);

    await fixture.service.validatePlacement({ intent: "sibling", source });
    await fixture.service.validatePlacement({ intent: "sibling", source });
    const opened = await openWorkspace(fixture, "ses_web_feature", {
      intent: "sibling",
      source,
    });

    expect(opened).toMatchObject({
      placement: {
        intent: "sibling",
        provider: "tmux",
        targetId: expect.stringMatching(/^tmux:[a-f0-9]{64}:\$1:@2:%2$/u),
        generation: expect.stringMatching(/^[a-f0-9]{64}$/u),
        presentation: "presented",
      },
      bindingToken: "binding_1",
      agentEndpointId: "%2",
    });
    const creation = fixture.calls.find(
      (call) => tmuxArgs(call)[0] === "if-shell" && tmuxArgs(call).join(" ").includes("new-window"),
    );
    const creationArgs = tmuxArgs(creation as ExternalCommandInput);
    expect(creationArgs).toEqual(expect.arrayContaining(["if-shell", "-F", "-t", "%1"]));
    expect(creationArgs.join(" ")).toContain('"new-window" "-d"');
    expect(creationArgs.join(" ")).toContain('"-t" "\\$1:"');
    expect(creationArgs.join(" ")).not.toContain("select-window");
    expect(creationArgs.join(" ")).not.toContain("mouse");
    expect(
      fixture.calls.every((call) => call.args?.slice(0, 2).join(" ") === `-S ${socketPath}`),
    ).toBe(true);
    expect(
      fixture.calls.every(
        (call) =>
          call.unsetEnv?.includes("TMUX") === true && call.unsetEnv?.includes("TMUX_PANE") === true,
      ),
    ).toBe(true);

    await expectCode(
      openWorkspace(fixture, "ses_replay", { intent: "sibling", source }),
      "TERMINAL_PLACEMENT_REJECTED",
    );
  });

  it("creates detached work only in the configured workbench and releases the exact token", async () => {
    const fixture = placementFixture();
    const opened = await openWorkspace(fixture, "ses_web_feature", { intent: "detached" });

    expect(opened.placement).toMatchObject({
      intent: "detached",
      presentation: "detached",
      targetId: expect.stringContaining(":$2:@2:%2"),
    });
    const creation = fixture.calls.find((call) => tmuxArgs(call)[0] === "new-window");
    expect(tmuxArgs(creation as ExternalCommandInput)).toEqual(
      expect.arrayContaining(["new-window", "-d", "-t", "station:", "set-option", "mouse", "on"]),
    );

    fixture.processStartTokens.delete(100);
    await expect(fixture.service.releasePlacedTarget(releaseRequest(opened))).resolves.toEqual({
      status: "released",
    });
    expect(fixture.calls.some((call) => tmuxArgs(call)[0] === "if-shell")).toBe(true);
    await expect(fixture.service.releasePlacedTarget(releaseRequest(opened))).resolves.toEqual({
      status: "already-absent",
    });
    expect(fixture.calls.some((call) => tmuxArgs(call)[0] === "list-clients")).toBe(false);
  });

  it("restores exact attached clients after creating a missing workbench session", async () => {
    const fixture = placementFixture({
      workbenchAbsent: true,
      clients: [sourceClient],
      clientsAfterSessionCreate: [
        { ...sourceClient, sessionId: "$2", windowId: "@2", paneId: "%2" },
      ],
    });

    await expect(
      openWorkspace(fixture, "ses_bootstrap", { intent: "detached" }),
    ).resolves.toMatchObject({
      placement: { intent: "detached", presentation: "detached" },
    });

    expect(
      fixture.calls
        .map((call) => tmuxArgs(call)[0])
        .filter((command) => command === "list-clients"),
    ).toHaveLength(4);
    expect(
      fixture.calls.filter((call) => tmuxArgs(call)[0] === "switch-client").map(tmuxArgs),
    ).toEqual([
      ["switch-client", "-E", "-Z", "-c", sourceClient.clientName, "-t", sourceClient.paneId],
    ]);
    expect(fixture.clients).toEqual([sourceClient]);
  });

  it("never restores exited, replaced, or newly attached client identities", async () => {
    const replaced = { ...sourceClient, clientName: "/dev/ttys002", clientPid: 301 };
    const exited = { ...sourceClient, clientName: "/dev/ttys003", clientPid: 302 };
    const moved = { ...sourceClient, sessionId: "$2", windowId: "@2", paneId: "%2" };
    const replacement = {
      ...replaced,
      clientPid: 999,
      sessionId: "$2",
      windowId: "@2",
      paneId: "%2",
    };
    const newlyAttached = {
      ...sourceClient,
      clientName: "/dev/ttys004",
      clientPid: 303,
      sessionId: "$2",
      windowId: "@2",
      paneId: "%2",
    };
    const fixture = placementFixture({
      workbenchAbsent: true,
      clients: [sourceClient, replaced, exited],
      clientsAfterSessionCreate: [moved, replacement, newlyAttached],
    });

    await openWorkspace(fixture, "ses_identity", { intent: "detached" });

    expect(
      fixture.calls.filter((call) => tmuxArgs(call)[0] === "switch-client").map(tmuxArgs),
    ).toEqual([
      ["switch-client", "-E", "-Z", "-c", sourceClient.clientName, "-t", sourceClient.paneId],
    ]);
    expect(fixture.clients).toEqual([sourceClient, replacement, newlyAttached]);
  });

  it("ignores an exact client that exits immediately before restoration", async () => {
    const fixture = placementFixture({
      workbenchAbsent: true,
      clients: [sourceClient],
      clientsAfterSessionCreate: [
        { ...sourceClient, sessionId: "$2", windowId: "@2", paneId: "%2" },
      ],
      exitClientsBeforeRestore: true,
    });

    await expect(
      openWorkspace(fixture, "ses_client_exit", { intent: "detached" }),
    ).resolves.toMatchObject({ placement: { intent: "detached" } });
    expect(fixture.calls.some((call) => tmuxArgs(call)[0] === "switch-client")).toBe(false);
    expect(fixture.clients).toEqual([]);
  });

  it("treats exact server absence as an empty client baseline", async () => {
    const fixture = placementFixture({ serverAbsent: true });

    await expect(
      openWorkspace(fixture, "ses_new_server", { intent: "detached" }),
    ).resolves.toMatchObject({
      placement: { intent: "detached", presentation: "detached" },
    });
    expect(fixture.calls.some((call) => tmuxArgs(call)[0] === "new-session")).toBe(true);
    expect(fixture.calls.some((call) => tmuxArgs(call)[0] === "switch-client")).toBe(false);
  });

  it("fails before mutation when attached client selection cannot be inspected", async () => {
    const fixture = placementFixture({ workbenchAbsent: true, failClientList: true });

    await expectCode(
      openWorkspace(fixture, "ses_client_list_failure", { intent: "detached" }),
      "TERMINAL_OPEN_FAILED",
    );
    expect(fixture.calls.some((call) => tmuxArgs(call)[0] === "new-session")).toBe(false);
  });

  it("reports uncertain cleanup when client restoration cannot converge", async () => {
    const fixture = placementFixture({
      workbenchAbsent: true,
      clients: [sourceClient],
      clientsAfterSessionCreate: [
        { ...sourceClient, sessionId: "$2", windowId: "@2", paneId: "%2" },
      ],
      restoreClients: false,
      restoreClientsAfterRollback: false,
    });

    await expectCode(
      openWorkspace(fixture, "ses_restore_failure", { intent: "detached" }),
      "TERMINAL_CLEANUP_UNCERTAIN",
    );
    expect(
      fixture.calls.some(
        (call) =>
          tmuxArgs(call)[0] === "if-shell" && tmuxArgs(call).join(" ").includes("kill-window"),
      ),
    ).toBe(true);
  });

  it("rejects endpoint mismatch, public-field tampering, and unqualified cleanup authority", async () => {
    const fixture = placementFixture();
    for (const [tmux, expected] of [
      [`${socketPath},1e1,0`, { code: "TERMINAL_CALLER_CONTEXT_REJECTED" }],
      [
        "/tmp/other.sock,10,0",
        {
          code: "TERMINAL_CALLER_CONTEXT_REJECTED",
          hint: expect.stringContaining("workbench_socket_path"),
        },
      ],
    ] as const) {
      await expect(
        fixture.service.resolveCurrentPlacement(caller({ TMUX: tmux, TMUX_PANE: "%1" })),
      ).rejects.toMatchObject(expected);
    }
    expect(fixture.calls.at(-1)?.args?.slice(0, 2)).toEqual(["-S", socketPath]);

    const source = await placementSource(fixture);
    await expectCode(
      fixture.service.validatePlacement({
        intent: "sibling",
        source: { ...source, generation: "tampered" },
      }),
      "TERMINAL_PLACEMENT_REJECTED",
    );
    await expectCode(
      fixture.service.releasePlacedTarget({
        targetId: "tmux:station:@1:%1",
        sessionId: "ses_web_feature",
        generation: source.generation,
        bindingToken: "binding_unknown",
      }),
      "TERMINAL_CLEANUP_UNCERTAIN",
    );
  });

  it.each([
    [100, "pane-replaced"],
    [10, "server-replaced"],
  ])("fails closed when process %i is replaced", async (pid, replacement) => {
    const fixture = placementFixture();
    const source = await placementSource(fixture);
    fixture.processStartTokens.set(pid, replacement);
    await expectCode(
      fixture.service.validatePlacement({ intent: "sibling", source }),
      "TERMINAL_PLACEMENT_REJECTED",
    );
  });

  it("rejects an expired authority and an atomic sibling guard replacement", async () => {
    const expired = placementFixture();
    const expiredSource = await placementSource(expired);
    expired.advance(11 * 60 * 1000);
    await expectCode(
      expired.service.validatePlacement({ intent: "sibling", source: expiredSource }),
      "TERMINAL_PLACEMENT_REJECTED",
    );

    const guarded = placementFixture();
    const guardedSource = await placementSource(guarded);
    guarded.rejectNextOpenGuard();
    await expectCode(
      openWorkspace(guarded, "ses_guarded", { intent: "sibling", source: guardedSource }),
      "TERMINAL_PLACEMENT_REJECTED",
    );
    expect(guarded.calls.some((call) => tmuxArgs(call)[0] === "list-panes")).toBe(false);
  });

  it.each([
    ["timeout after mutation", { failOpenAfterMutation: true }, "TERMINAL_TMUX_TIMEOUT"],
    ["missing session binding", { omitStationSessionId: true }, "TERMINAL_PLACEMENT_REJECTED"],
  ] as const)("rolls back the exact binding on %s", async (_scenario, options, code) => {
    const fixture = placementFixture(options);
    await expectCode(openWorkspace(fixture, "ses_rollback", { intent: "detached" }), code);
    expect(
      fixture.calls.some((call) => {
        const args = tmuxArgs(call);
        return args[0] === "if-shell" && args.join(" ").includes("kill-window");
      }),
    ).toBe(true);
  });

  it("refuses release when the exact binding token no longer matches", async () => {
    const fixture = placementFixture();
    const opened = await openWorkspace(fixture, "ses_binding", { intent: "detached" });

    await expectCode(
      fixture.service.releasePlacedTarget(
        releaseRequest(opened, { bindingToken: "replacement-token" }),
      ),
      "TERMINAL_CLEANUP_UNCERTAIN",
    );
  });

  it("retains recovery state when the binding changes during guarded release", async () => {
    const fixture = placementFixture({ mutateReleaseBinding: true });
    const opened = await openWorkspace(fixture, "ses_binding_race", { intent: "detached" });

    await expectCode(
      fixture.service.releasePlacedTarget(releaseRequest(opened)),
      "TERMINAL_CLEANUP_UNCERTAIN",
    );
  });
});

function placementFixture(
  options: {
    failOpenAfterMutation?: boolean;
    omitStationSessionId?: boolean;
    mutateReleaseBinding?: boolean;
    workbenchAbsent?: boolean;
    serverAbsent?: boolean;
    failClientList?: boolean;
    clients?: FixtureClientSelection[];
    clientsAfterSessionCreate?: FixtureClientSelection[];
    exitClientsBeforeRestore?: boolean;
    restoreClients?: boolean;
    restoreClientsAfterRollback?: boolean;
  } = {},
) {
  const calls: ExternalCommandInput[] = [];
  let currentNow = new Date(now);
  let rejectOpenGuard = false;
  const processStartTokens = new Map([
    [10, "server"],
    [100, "pane"],
    [101, "caller"],
    [200, "placed-pane"],
  ]);
  let binding = 0;
  let placed: string | undefined;
  let mutateReleaseBinding = options.mutateReleaseBinding === true;
  let serverExists = options.serverAbsent !== true;
  let workbenchExists = serverExists && options.workbenchAbsent !== true;
  let createdWorkbenchSession = false;
  let clientListCount = 0;
  const initialClients = options.clients?.map((client) => ({ ...client })) ?? [];
  const clients = initialClients.map((client) => ({ ...client }));
  const replaceClients = (next: readonly FixtureClientSelection[]) => {
    clients.splice(0, clients.length, ...next.map((client) => ({ ...client })));
  };
  const service = new TmuxPlacementService({
    config: { workbenchSession: "station", workbenchSocketPath: socketPath },
    clock: { now: () => currentNow },
    newBindingToken: () => `binding_${++binding}`,
    socketEvidence: () => ({ device: "1", inode: "2" }),
    processEvidence: {
      read: (pid) => {
        const startToken = processStartTokens.get(pid);
        if (startToken === undefined) return undefined;
        const parentPid = pid === 101 ? 100 : pid === 100 ? 1 : 0;
        return { pid, parentPid, startToken };
      },
    },
    runner: async (input) => {
      calls.push(input);
      const args = tmuxArgs(input);
      if (args[0] === "display-message" && args.at(-1) === tmuxPaneProofFormat) {
        return tmuxCommandResult(input, sourceProof);
      }
      if (
        args[0] === "display-message" &&
        args.includes("-c") &&
        args.at(-1) === tmuxClientSelectionFormat
      ) {
        const clientName = args[args.indexOf("-c") + 1];
        const selection = clients.find((client) => client.clientName === clientName);
        if (selection === undefined) {
          throw Object.assign(new Error("tmux failed"), {
            code: 1,
            stderr: `can't find client: ${clientName}`,
          });
        }
        return tmuxCommandResult(input, serializeClientSelection(selection));
      }
      if (args[0] === "has-session") {
        if (!serverExists) {
          throw Object.assign(new Error("tmux failed"), {
            code: 1,
            stderr: `no server running on ${socketPath}`,
          });
        }
        if (!workbenchExists) {
          throw Object.assign(new Error("tmux failed"), {
            code: 1,
            stderr: "can't find session: station",
          });
        }
        return tmuxCommandResult(input, "");
      }
      if (args[0] === "list-clients") {
        clientListCount += 1;
        if (!serverExists) {
          throw Object.assign(new Error("tmux failed"), {
            code: 1,
            stderr: `no server running on ${socketPath}`,
          });
        }
        if (options.failClientList === true) {
          throw Object.assign(new Error("tmux failed"), {
            code: 1,
            stderr: "client inspection failed",
          });
        }
        if (options.exitClientsBeforeRestore === true && clientListCount === 3) {
          replaceClients([]);
        }
        return tmuxCommandResult(
          input,
          clients.map((client) => `${client.clientName}\t${client.clientPid}`).join("\n"),
        );
      }
      if (
        args[0] === "new-session" ||
        args[0] === "new-window" ||
        (args[0] === "if-shell" && args.join(" ").includes("new-window"))
      ) {
        if (rejectOpenGuard && args[0] === "if-shell") {
          rejectOpenGuard = false;
          return tmuxCommandResult(input, "__station_open_guard_rejected__");
        }
        const serialized = args.join(" ");
        const sibling = serialized.includes("$1:");
        const token =
          args[0] !== "if-shell"
            ? (args[args.indexOf("@station.open_token") + 1] ?? "")
            : (/@station\.open_token" "([^"]+)"/u.exec(serialized)?.[1] ?? "");
        const stationSessionId =
          args[0] !== "if-shell"
            ? (args[args.indexOf("@station.session_id") + 1] ?? "")
            : (/@station\.session_id" "([^"]+)"/u.exec(serialized)?.[1] ?? "");
        const sessionId = sibling ? "$1" : "$2";
        const sessionName = sibling ? "caller" : "station";
        const sessionBinding = options.omitStationSessionId === true ? "" : stationSessionId;
        placed = `${socketPath}\t10\t${sessionId}\t${sessionName}\t@2\t%2\t200\t${token}\t${sessionBinding}`;
        if (args[0] === "new-session") {
          serverExists = true;
          workbenchExists = true;
          createdWorkbenchSession = true;
          if (options.clientsAfterSessionCreate !== undefined) {
            replaceClients(options.clientsAfterSessionCreate);
          }
        }
        if (options.failOpenAfterMutation === true) {
          throw {
            tag: "TimeoutError",
            code: "TERMINAL_TMUX_TIMEOUT",
            message: "tmux timed out after creating the window.",
          };
        }
        return tmuxCommandResult(input, placed);
      }
      if (args[0] === "switch-client") {
        if (
          options.restoreClients !== false ||
          (placed === undefined && options.restoreClientsAfterRollback !== false)
        ) {
          const clientName = args[args.indexOf("-c") + 1];
          const paneId = args[args.indexOf("-t") + 1];
          const expected = initialClients.find(
            (client) => client.clientName === clientName && client.paneId === paneId,
          );
          const index = clients.findIndex(
            (client) =>
              client.clientName === clientName && client.clientPid === expected?.clientPid,
          );
          if (expected !== undefined && index >= 0) clients[index] = { ...expected };
        }
        return tmuxCommandResult(input, "");
      }
      if (args[0] === "list-panes") {
        return tmuxCommandResult(
          input,
          [sourceProof, ...(placed === undefined ? [] : [placed])].join("\n"),
        );
      }
      if (args[0] === "if-shell") {
        if (args.join(" ").includes("kill-window")) {
          if (mutateReleaseBinding && placed !== undefined) {
            mutateReleaseBinding = false;
            const fields = placed.split("\t");
            fields[7] = "replacement-binding";
            placed = fields.join("\t");
            return tmuxCommandResult(input, "__station_release_guard_rejected__");
          }
          placed = undefined;
          if (createdWorkbenchSession) workbenchExists = false;
          if (options.restoreClientsAfterRollback !== false) replaceClients(initialClients);
          return tmuxCommandResult(input, "");
        }
        placed = undefined;
        return tmuxCommandResult(input, "");
      }
      if (args[0] === "-V") return tmuxCommandResult(input, "tmux 3.5");
      throw new Error(`Unexpected tmux command: ${args.join(" ")}`);
    },
  });
  return {
    service,
    calls,
    clients,
    processStartTokens,
    advance: (milliseconds: number) => {
      currentNow = new Date(currentNow.getTime() + milliseconds);
    },
    rejectNextOpenGuard: () => {
      rejectOpenGuard = true;
    },
  };
}

function serializeClientSelection(selection: FixtureClientSelection): string {
  return [
    selection.clientName,
    String(selection.clientPid),
    selection.sessionId,
    selection.windowId,
    selection.paneId,
  ].join("\t");
}

async function placementSource(fixture: ReturnType<typeof placementFixture>) {
  const source = await fixture.service.resolveCurrentPlacement(caller());
  if (source === undefined) throw new Error("Expected placement source.");
  return source;
}

function openWorkspace(
  fixture: ReturnType<typeof placementFixture>,
  sessionId: string,
  placement: TerminalPlacementRequest,
) {
  return fixture.service.openPlacedWorkspace({
    project,
    worktree,
    harness: "codex",
    layout: "agent-shell",
    sessionId,
    placement,
  } satisfies OpenPlacedWorkspaceRequest);
}

function releaseRequest(
  opened: Awaited<ReturnType<TmuxPlacementService["openPlacedWorkspace"]>>,
  overrides: { bindingToken?: string } = {},
) {
  return {
    targetId: opened.target.targetId,
    sessionId: opened.target.sessionId,
    generation: opened.placement.generation,
    bindingToken: overrides.bindingToken ?? opened.bindingToken,
  };
}

function expectCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ code });
}

function caller(claims: Record<string, string> = { TMUX: `${socketPath},10,0`, TMUX_PANE: "%1" }) {
  return { process: { pid: 101, startToken: "caller" }, claims };
}

function tmuxArgs(input: ExternalCommandInput): string[] {
  return input.args?.slice(0, 2).join(" ") === `-S ${socketPath}`
    ? (input.args?.slice(2) ?? [])
    : (input.args ?? []);
}
