import { describe, expect, it } from "bun:test";
import { installObserverTransportDeliveryProbe } from "./observerTransportDeliveryProbe.js";

describe("observer transport delivery probe", () => {
  it("runs once, validates exact health, writes one sentinel, and removes its signal handler", async () => {
    let listener: (() => void) | undefined;
    let requests = 0;
    let removals = 0;
    let completion = "";
    let resolveWritten: () => void = () => undefined;
    const written = new Promise<void>((resolve) => {
      resolveWritten = resolve;
    });
    const probe = installObserverTransportDeliveryProbe(
      {
        socketPath: "/tmp/station-observer.sock",
        expectedBuildVersion: "0.7.0+station.exact",
        completionPath: "/tmp/station-idle-probe.json",
      },
      {
        requestHealth: async () => {
          requests += 1;
          return { status: "healthy", version: "0.7.0+station.exact" };
        },
        writeCompletion: async (_path, contents) => {
          completion = contents;
          resolveWritten();
        },
        addSignalListener: (candidate) => {
          listener = candidate;
        },
        removeSignalListener: (candidate) => {
          expect(candidate).toBe(listener);
          removals += 1;
        },
      },
    );

    expect(listener).toBeDefined();
    listener?.();
    listener?.();
    await written;
    probe.dispose();

    expect(requests).toBe(1);
    expect(removals).toBe(1);
    expect(JSON.parse(completion)).toEqual({
      status: "complete",
      requestId: `req_bench_047_idle_${process.pid}`,
    });
  });

  it("writes a failed sentinel when health identity does not match", async () => {
    let listener: (() => void) | undefined;
    let completion = "";
    let resolveWritten: () => void = () => undefined;
    const written = new Promise<void>((resolve) => {
      resolveWritten = resolve;
    });
    installObserverTransportDeliveryProbe(
      {
        socketPath: "/tmp/station-observer.sock",
        expectedBuildVersion: "0.7.0+station.expected",
        completionPath: "/tmp/station-idle-probe.json",
      },
      {
        requestHealth: async () => ({
          status: "healthy",
          version: "0.7.0+station.different",
        }),
        writeCompletion: async (_path, contents) => {
          completion = contents;
          resolveWritten();
        },
        addSignalListener: (candidate) => {
          listener = candidate;
        },
        removeSignalListener: () => undefined,
      },
    );

    listener?.();
    await written;

    expect(JSON.parse(completion)).toEqual({
      status: "failed",
      requestId: `req_bench_047_idle_${process.pid}`,
    });
  });
});
