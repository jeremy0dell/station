import { describe, expect, it } from "bun:test";
import {
  beginHotDisposal,
  registerHotDisposal,
  type StationHotDisposalSlots,
  waitForHotDisposal,
} from "./hotDisposalBarrier.js";

function createSlots(): StationHotDisposalSlots {
  return {} as StationHotDisposalSlots;
}

describe("Station HMR disposal barrier", () => {
  it("releases each runtime reload once and waits for cleanup before replacement", async () => {
    const slots = createSlots();
    const signal = "SIGHUP";
    const before = process.listenerCount(signal);
    for (let generation = 0; generation < 4; generation++) {
      const listener = (): void => {};
      const pending = deferred();
      let releases = 0;
      process.on(signal, listener);
      try {
        const release = registerHotDisposal(
          slots,
          () => {
            releases++;
            process.off(signal, listener);
            return pending.promise;
          },
          () => {},
        );
        expect(process.listenerCount(signal)).toBe(before + 1);
        slots.__stationHotDispose?.();
        release();
        expect(releases).toBe(1);
        expect(process.listenerCount(signal)).toBe(before);
        expect(slots.__stationHotDispose).toBeUndefined();
        let settled = false;
        const replacement = waitForHotDisposal(slots).then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        pending.resolve();
        await replacement;
        expect(settled).toBe(true);
      } finally {
        process.off(signal, listener);
        pending.resolve();
      }
    }
  });

  it("publishes before cleanup and fulfills after synchronous or asynchronous failure", async () => {
    const slots = createSlots();
    const reported: unknown[] = [];
    let publishedBeforeCleanup: Promise<void> | undefined;
    const synchronous = beginHotDisposal(
      slots,
      () => {
        publishedBeforeCleanup = slots.__stationHotDisposal;
        throw new Error("synchronous cleanup failure");
      },
      (error) => reported.push(error),
    );
    expect(publishedBeforeCleanup).toBe(synchronous);

    await waitForHotDisposal(slots);
    expect(reported).toHaveLength(1);

    const asynchronous = beginHotDisposal(
      slots,
      async () => {
        throw new Error("asynchronous cleanup failure");
      },
      (error) => reported.push(error),
    );

    await asynchronous;
    expect(reported).toHaveLength(2);
    expect(slots.__stationHotDisposal).toBeUndefined();
  });

  it("keeps generation C published when stale A and B settlements overlap it", async () => {
    const slots = createSlots();
    const reported: unknown[] = [];
    const generationA = deferred();
    const generationB = deferred();
    const generationC = deferred();

    const barrierA = beginHotDisposal(slots, () => generationA.promise, (error) =>
      reported.push(error),
    );
    const waitForA = waitForHotDisposal(slots);
    const barrierB = beginHotDisposal(slots, () => generationB.promise, (error) =>
      reported.push(error),
    );
    const barrierC = beginHotDisposal(slots, () => generationC.promise, (error) =>
      reported.push(error),
    );

    generationA.reject(new Error("A failed"));
    await waitForA;
    expect(slots.__stationHotDisposal).toBe(barrierC);

    generationB.reject(new Error("B failed"));
    await barrierB;
    expect(slots.__stationHotDisposal).toBe(barrierC);

    let replacementStarted = false;
    void observeSettlement(waitForHotDisposal(slots), () => {
      replacementStarted = true;
    });
    await Promise.resolve();
    expect(replacementStarted).toBe(false);

    generationC.resolve();
    await barrierC;
    await Promise.resolve();
    expect(slots.__stationHotDisposal).toBeUndefined();
    expect(reported).toHaveLength(2);
    await barrierA;
  });
});

async function observeSettlement(
  settlement: Promise<void>,
  observe: () => void,
): Promise<void> {
  await settlement;
  observe();
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
