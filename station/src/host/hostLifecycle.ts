import type {
  UiLifecycleEventInputFor,
  UiLifecyclePtyKind,
  UiRunId,
} from "@station/contracts";
import type { UiLifecycleRecorder } from "@station/observability";
import type { HostClientIdentity } from "@station/host";
import type { PtyExitEvent, PtySpawnOutcome } from "./ptyTable.js";

type HostLifecycleEventInput = UiLifecycleEventInputFor<"station-host">;

type PtyCorrelation = {
  uiRunId: UiRunId;
  ptyKind: UiLifecyclePtyKind;
};

export type HostLifecycleWitness = {
  record(event: HostLifecycleEventInput): Promise<void>;
  ptySpawned(
    client: HostClientIdentity,
    outcome: PtySpawnOutcome,
    ptyKind: UiLifecyclePtyKind,
  ): Promise<void>;
  ptyExited(event: PtyExitEvent): Promise<void>;
  flush(): Promise<void>;
};

/** Record typed Host lifecycle evidence while retaining each PTY's original UI creator. */
export function createHostLifecycleWitness(input: {
  recorder: UiLifecycleRecorder<"station-host">;
}): HostLifecycleWitness {
  const ptyCorrelations = new Map<string, PtyCorrelation>();
  const pendingExits = new Map<string, PtyExitEvent>();

  const record = async (event: HostLifecycleEventInput): Promise<void> => {
    try {
      await input.recorder.record(event, "info");
    } catch {
      // Diagnostic evidence must not alter Host protocol or PTY lifecycle behavior.
    }
  };

  const ptyExited = async (event: PtyExitEvent): Promise<void> => {
    const correlation = ptyCorrelations.get(event.ptyId);
    if (correlation === undefined) {
      // A terminal may replay exit while spawn subscriptions are being installed.
      pendingExits.set(event.ptyId, event);
      return;
    }
    ptyCorrelations.delete(event.ptyId);
    await record({
      kind: "host.pty.exited",
      uiRunId: correlation.uiRunId,
      ptyId: event.ptyId,
      ptyKind: correlation.ptyKind,
      exitCode: event.exitCode,
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    });
  };

  return {
    record,
    async ptySpawned(client, outcome, ptyKind) {
      if (!outcome.created) {
        return;
      }
      ptyCorrelations.set(outcome.ptyId, { uiRunId: client.uiRunId, ptyKind });
      await record({
        kind: "host.pty.spawned",
        uiRunId: client.uiRunId,
        ptyId: outcome.ptyId,
        ptyKind,
        pid: outcome.pid,
      });
      const pendingExit = pendingExits.get(outcome.ptyId);
      if (pendingExit !== undefined) {
        pendingExits.delete(outcome.ptyId);
        await ptyExited(pendingExit);
      }
    },
    ptyExited,
    async flush() {
      try {
        await input.recorder.flush();
      } catch {
        // Host shutdown remains authoritative even when evidence cannot flush.
      }
    },
  };
}
