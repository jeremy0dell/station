import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { OpenPlacedWorkspaceRequest, OpenPlacedWorkspaceResult } from "@station/contracts";
import { resolveExecutablePath } from "@station/runtime";
import { beforeAll, describe, expect, it } from "vitest";
import {
  closeRealTmuxEndpoint,
  inspectTmuxClient,
  type RealTmuxEndpoint,
  startAttachedTmuxPtyClient,
} from "../../../../../tests/support/real-station/tmux.js";
import { TmuxPlacementService } from "../../src/placement/index.js";

const execFileAsync = promisify(execFile);
const describeRealTmux = process.env.STATION_REAL_TMUX === "1" ? describe : describe.skip;

describeRealTmux("real tmux detached placement", () => {
  let tmux: string;

  beforeAll(async () => {
    const requested = process.env.STATION_TMUX_BIN ?? "tmux";
    const resolved = await resolveExecutablePath(requested);
    if (resolved === undefined) throw new Error(`tmux executable not found: ${requested}`);
    tmux = resolve(resolved);
    await execFileAsync(tmux, ["-V"], { timeout: 10_000 });
    await execFileAsync("python3", ["--version"], { timeout: 10_000 });
  });

  it("preserves an attached client's exact target while bootstrapping and reusing the workbench", async () => {
    const endpoint = await createEndpoint(tmux);
    let client: Awaited<ReturnType<typeof startAttachedTmuxPtyClient>> | undefined;
    const failures: unknown[] = [];
    try {
      client = await startAttachedTmuxPtyClient({
        endpoint,
        sessionName: "_station-real-endpoint",
      });
      const expectedClient = await inspectTmuxClient(endpoint, client.clientName);
      const service = new TmuxPlacementService({
        command: endpoint.wrapperPath,
        config: {
          workbenchSession: "station-placement-real",
          workbenchSocketPath: endpoint.socketPath,
        },
      });

      const first = await service.openPlacedWorkspace(request(endpoint.rootPath, 1));
      expect(first).toMatchObject({
        placement: { intent: "detached", presentation: "detached" },
        target: { providerData: { sessionName: "station-placement-real" } },
      });
      await expect(inspectTmuxClient(endpoint, client.clientName)).resolves.toBe(expectedClient);

      const second = await service.openPlacedWorkspace(request(endpoint.rootPath, 2));
      expect(second).toMatchObject({
        placement: { intent: "detached", presentation: "detached" },
        target: { providerData: { sessionName: "station-placement-real" } },
      });
      await expect(inspectTmuxClient(endpoint, client.clientName)).resolves.toBe(expectedClient);

      await service.releasePlacedTarget(releaseRequest(second));
      await expect(inspectTmuxClient(endpoint, client.clientName)).resolves.toBe(expectedClient);
      await service.releasePlacedTarget(releaseRequest(first));
      await expect(inspectTmuxClient(endpoint, client.clientName)).resolves.toBe(expectedClient);
    } catch (error) {
      failures.push(error);
    } finally {
      if (client !== undefined) {
        await client.close().catch((error: unknown) => failures.push(error));
      }
      await closeRealTmuxEndpoint(endpoint).catch((error: unknown) => failures.push(error));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `real tmux placement proof or cleanup failed: ${failures.map(String).join("; ")}`,
      );
    }
  });
});

function request(root: string, sequence: number): OpenPlacedWorkspaceRequest {
  return {
    project: {
      id: "placement-real",
      label: "placement-real",
      root,
      defaults: { harness: "codex", terminal: "tmux", layout: "agent-only" },
      worktrunk: { enabled: true },
    },
    worktree: {
      id: `wt_placement_${sequence}`,
      provider: "worktrunk",
      projectId: "placement-real",
      branch: `placement-${sequence}`,
      path: root,
      state: "exists",
      source: "worktrunk",
      observedAt: new Date().toISOString(),
    },
    harness: "codex",
    layout: "agent-only",
    sessionId: `ses_placement_${sequence}`,
    placement: { intent: "detached" },
  };
}

function releaseRequest(opened: OpenPlacedWorkspaceResult) {
  const sessionId = opened.target.sessionId;
  if (sessionId === undefined) throw new Error("placed target omitted its Station session ID");
  return {
    targetId: opened.target.targetId,
    sessionId,
    generation: opened.placement.generation,
    bindingToken: opened.bindingToken,
  };
}

async function createEndpoint(tmux: string): Promise<RealTmuxEndpoint> {
  const rootPath = await mkdtemp(join(tmpdir(), "stn-placement-real-"));
  const endpoint = {
    rootPath,
    socketPath: join(rootPath, "server.sock"),
    wrapperPath: join(rootPath, "tmux"),
  };
  await chmod(rootPath, 0o700);
  await writeFile(endpoint.wrapperPath, `#!/bin/sh\nexec ${shellQuote(tmux)} -f /dev/null "$@"\n`);
  await chmod(endpoint.wrapperPath, 0o700);
  try {
    await execFileAsync(
      endpoint.wrapperPath,
      [
        "-S",
        endpoint.socketPath,
        "new-session",
        "-d",
        "-s",
        "_station-real-endpoint",
        "sleep",
        "300",
      ],
      { timeout: 10_000 },
    );
    return endpoint;
  } catch (error) {
    await closeRealTmuxEndpoint(endpoint).catch(() => undefined);
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
