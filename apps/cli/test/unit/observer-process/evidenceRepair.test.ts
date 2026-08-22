import { describe, expect, it, vi } from "vitest";
import { repairLocalObserverEvidence } from "../../../src/observerProcess/evidenceRepair.js";

const socketPath = "/tmp/station/observer.sock";

describe("CLI Observer evidence repair composition", () => {
  it("holds and releases the boot claim around an idempotent repair", async () => {
    const release = vi.fn(() => ({ status: "released" as const }));
    const acquireClaim = vi.fn(async () => ({
      status: "acquired" as const,
      path: "/tmp/station/observer.claim.sqlite",
      release,
    }));
    const probeSocket = vi.fn(async () => ({ status: "absent" as const }));

    await expect(
      repairLocalObserverEvidence(
        { socketPath, timeoutMs: 5_000 },
        {
          acquireClaim,
          processEvidence: {
            socketHolders: () => [],
            readObserverProcess: () => undefined,
            processStartToken: () => undefined,
          } as never,
          processExistenceEvidence: {
            readProcessExistence: () => ({ status: "absent" }),
          },
          identityRepair: {
            read: async () => undefined,
            removeIfExact: async () => false,
          },
          probeSocket,
          now: () => 100,
        },
      ),
    ).resolves.toEqual({ socket: "absent", pidfile: "absent" });

    expect(acquireClaim).toHaveBeenCalledWith({ socketPath, timeoutMs: 5_000 });
    expect(probeSocket).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("returns a typed refusal and releases the claim when a listener owns the path", async () => {
    const release = vi.fn(() => ({ status: "released" as const }));

    await expect(
      repairLocalObserverEvidence(
        { socketPath, timeoutMs: 5_000 },
        {
          acquireClaim: async () => ({
            status: "acquired",
            path: "/tmp/station/observer.claim.sqlite",
            release,
          }),
          processEvidence: { socketHolders: () => [] } as never,
          processExistenceEvidence: {
            readProcessExistence: () => ({ status: "absent" }),
          },
          identityRepair: {
            read: async () => undefined,
            removeIfExact: async () => false,
          },
          probeSocket: async () => ({
            status: "listening",
            identity: { ino: 10n, birthtimeNs: 20n },
          }),
          now: () => 100,
        },
      ),
    ).rejects.toMatchObject({ code: "OBSERVER_STALE_EVIDENCE_OWNER_CHANGED" });

    expect(release).toHaveBeenCalledTimes(1);
  });
});
