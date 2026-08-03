import type { UiLifecycleEventInputFor } from "@station/contracts";
import type { UiLifecycleRecorder } from "@station/observability";
import type { HostClientIdentity } from "@station/host";
import { describe, expect, it } from "bun:test";
import { createHostLifecycleWitness } from "./hostLifecycle.js";

const firstClient: HostClientIdentity = {
  protocolVersion: 6,
  buildVersion: "test-build",
  uiRunId: "ui_11111111-1111-4111-8111-111111111111",
  rendererPid: 100,
  clientKind: "native_renderer",
  connectionId: "conn-one",
};
const secondClient: HostClientIdentity = {
  ...firstClient,
  uiRunId: "ui_22222222-2222-4222-8222-222222222222",
  rendererPid: 200,
  connectionId: "conn-two",
};

describe("Host lifecycle witness", () => {
  it("retains the original creator across idempotent PTY reuse and exit", async () => {
    const events: UiLifecycleEventInputFor<"station-host">[] = [];
    const recorder = {
      record: async (event) => {
        events.push(event);
        return { component: "station-host", ...event } as never;
      },
      flush: async () => undefined,
    } satisfies UiLifecycleRecorder<"station-host">;
    const witness = createHostLifecycleWitness({ recorder });

    await witness.ptySpawned(
      firstClient,
      { ptyId: "pty-1", pid: 101, created: true },
      "agent",
    );
    await witness.ptySpawned(
      secondClient,
      { ptyId: "pty-1", pid: 101, created: false },
      "agent",
    );
    await witness.ptyExited({ ptyId: "pty-1", ptyKind: "agent", exitCode: 0 });

    expect(events).toEqual([
      {
        kind: "host.pty.spawned",
        uiRunId: firstClient.uiRunId,
        ptyId: "pty-1",
        ptyKind: "agent",
        pid: 101,
      },
      {
        kind: "host.pty.exited",
        uiRunId: firstClient.uiRunId,
        ptyId: "pty-1",
        ptyKind: "agent",
        exitCode: 0,
      },
    ]);
  });

  it("orders a synchronously replayed exit after its spawn correlation", async () => {
    const events: UiLifecycleEventInputFor<"station-host">[] = [];
    const recorder = {
      record: async (event) => {
        events.push(event);
        return { component: "station-host", ...event } as never;
      },
      flush: async () => undefined,
    } satisfies UiLifecycleRecorder<"station-host">;
    const witness = createHostLifecycleWitness({ recorder });

    await witness.ptyExited({ ptyId: "pty-early", ptyKind: "aux", exitCode: 7 });
    await witness.ptySpawned(
      firstClient,
      { ptyId: "pty-early", pid: 303, created: true },
      "aux",
    );

    expect(events.map((event) => event.kind)).toEqual([
      "host.pty.spawned",
      "host.pty.exited",
    ]);
  });
});
