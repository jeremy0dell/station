import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderProjectConfig, WorktreeObservation } from "@station/contracts";
import { createLocalProcessEvidence } from "@station/runtime";
import { StationTerminalProvider } from "@station/terminal";
import { describe, expect, it } from "vitest";
import { createStationNativePlacementEndpoint } from "../../../station/src/nativePlacementEndpoint.js";
import { createStationStore } from "../../../station/src/state/store.js";
import { MAIN_PANE_ID } from "../../../station/src/state/types.js";
import { createPtyRegistry } from "../../../station/src/terminal/registry/ptyRegistry.js";
import { createScriptedTerminal } from "../../../station/src/terminal/testing/scriptedTerminal.js";

const describeReal = process.env.STATION_REAL_E2E === "1" ? describe : describe.skip;

describeReal("real native session placement", () => {
  it("proves a live pane process and opens an inactive native sibling", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "stn-np-"));
    const sourceProcess = spawn("/bin/sh", ["-c", "sleep 60"], { stdio: "ignore" });
    const destinationProcess = spawn("/bin/sh", ["-c", "sleep 60"], { stdio: "ignore" });
    const source = createScriptedTerminal({ cols: 93, rows: 31 });
    const destination = createScriptedTerminal();
    const store = createStationStore();
    const terminals = [source.terminal, destination.terminal];
    const registry = createPtyRegistry({
      createTerminal: () => {
        const terminal = terminals.shift();
        if (terminal === undefined) throw new Error("terminal pool exhausted");
        return terminal;
      },
    });
    let endpoint: Awaited<ReturnType<typeof createStationNativePlacementEndpoint>> | undefined;
    try {
      const sourcePid = requirePid(sourceProcess);
      const destinationPid = requirePid(destinationProcess);
      Object.assign(source.terminal, { pid: sourcePid });
      Object.assign(destination.terminal, { pid: destinationPid });
      registry.resize(MAIN_PANE_ID, { cols: 93, rows: 31 });
      endpoint = await createStationNativePlacementEndpoint({
        stateDir,
        uiRunId: "np",
      });
      endpoint.attach({
        store,
        registry,
        createHostTerminal: () => {
          throw new Error("Host attachment was not expected");
        },
      });

      const provider = new StationTerminalProvider({ placement: { stateDir } });
      const placement = provider.placement;
      if (placement === undefined) throw new Error("native placement was not composed");
      const caller = createLocalProcessEvidence().read(sourcePid);
      if (caller === undefined) throw new Error("source process evidence was unavailable");
      const sourceAuthority = await placement.resolveCurrentPlacement({
        process: { pid: caller.pid, startToken: caller.startToken },
        claims: { STATION_PANE: "1" },
      });
      if (sourceAuthority === undefined) throw new Error("native caller was not proved");

      const project: ProviderProjectConfig = {
        id: "native-placement",
        label: "native-placement",
        root: stateDir,
        defaults: { harness: "scripted", terminal: "native", layout: "agent-only" },
        worktrunk: { enabled: true, base: "main" },
      };
      const worktree: WorktreeObservation = {
        id: "wt-native-placement",
        provider: "worktrunk",
        projectId: project.id,
        branch: "native-placement",
        path: stateDir,
        state: "exists",
        source: "worktrunk",
        observedAt: new Date().toISOString(),
      };
      const opened = await placement.openPlacedWorkspace({
        project,
        worktree,
        harness: "scripted",
        layout: "agent-only",
        sessionId: "ses-native-placement",
        placement: { intent: "sibling", source: sourceAuthority },
      });
      const launched = await provider.launchManagedProcess({
        project,
        worktree,
        terminalTarget: opened.target,
        agentEndpointId: opened.agentEndpointId,
        bindingToken: opened.bindingToken,
        launchPlan: {
          provider: "scripted",
          command: "/bin/sh",
          args: ["-c", "sleep 60"],
          cwd: stateDir,
          mode: "interactive",
        },
      });
      await placement.finalizePlacedTarget({
        targetId: opened.target.targetId,
        sessionId: "ses-native-placement",
        generation: opened.placement.generation,
        bindingToken: opened.bindingToken,
      });

      expect(sourceAuthority.provider).toBe("native");
      expect(opened.placement).toMatchObject({
        provider: "native",
        intent: "sibling",
        presentation: "presented",
      });
      expect(launched.started).toBe(true);
      expect(placement.hasPendingBinding(opened.bindingToken)).toBe(false);
      expect(store.getState().workspace.activePaneId).toBe(MAIN_PANE_ID);
      expect(
        store.getState().workspace.panes.find((pane) => pane.worktreeId === worktree.id),
      ).toMatchObject({
        agentIdentity: {
          sessionId: "ses-native-placement",
          terminalTargetId: opened.target.targetId,
          processOwner: "ui",
        },
      });
    } finally {
      await endpoint?.close();
      registry.disposeAll();
      await stopProcess(sourceProcess);
      await stopProcess(destinationProcess);
      await rm(stateDir, { recursive: true, force: true });
    }
  }, 30_000);
});

function requirePid(child: ChildProcess): number {
  if (child.pid === undefined) throw new Error("child process did not start");
  return child.pid;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}
