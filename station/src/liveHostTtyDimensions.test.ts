import { describe, expect, it } from "bun:test";
import { installLiveHostTtyDimensions } from "./liveHostTtyDimensions.js";

type FakeTty = {
  columns: number;
  fd: number;
  isTTY: boolean;
  rows: number;
  emit?: (event: "resize") => unknown;
};

function fakeTty(input: Partial<FakeTty> = {}): FakeTty {
  return {
    columns: 80,
    fd: 1,
    isTTY: true,
    rows: 24,
    ...input,
  };
}

function resizeSubscription(): {
  subscribe(listener: () => void): void;
  resize(): void;
  subscriptions(): number;
} {
  let listener: (() => void) | undefined;
  let subscriptions = 0;
  return {
    subscribe(nextListener) {
      listener = nextListener;
      subscriptions += 1;
    },
    resize() {
      listener?.();
    },
    subscriptions: () => subscriptions,
  };
}

describe("installLiveHostTtyDimensions", () => {
  it("publishes one coherent stdout size per refresh", () => {
    const stdout = fakeTty({ fd: 1 });
    const stdin = fakeTty({ fd: 0 });
    const samples = [
      { columns: 80, rows: 24 },
      { columns: 120, rows: 40 },
      { columns: 60, rows: 18 },
    ];
    const queriedFds: number[] = [];
    const resize = resizeSubscription();

    installLiveHostTtyDimensions({
      stdin,
      stdout,
      readWindowSize: (fd) => {
        queriedFds.push(fd);
        return samples.shift();
      },
      subscribeToResize: resize.subscribe,
    });

    resize.resize();
    expect({ columns: stdout.columns, rows: stdout.rows }).toEqual({ columns: 120, rows: 40 });
    resize.resize();
    expect({ columns: stdout.columns, rows: stdout.rows }).toEqual({ columns: 60, rows: 18 });
    expect(queriedFds).toEqual([1, 1, 1]);
  });

  it("refreshes through the stream's native size method", () => {
    const stdout = fakeTty() as FakeTty & { _refreshSize: () => void };
    const stdin = fakeTty({ fd: 0 });
    const resize = resizeSubscription();
    let size = { columns: 118, rows: 38 };
    stdout._refreshSize = function (this: FakeTty): void {
      this.columns = size.columns;
      this.rows = size.rows;
    };

    installLiveHostTtyDimensions({ stdin, stdout, subscribeToResize: resize.subscribe });

    expect({ columns: stdout.columns, rows: stdout.rows }).toEqual(size);
    size = { columns: 62, rows: 17 };
    resize.resize();
    expect({ columns: stdout.columns, rows: stdout.rows }).toEqual(size);
  });

  it("uses a TTY stdin when stdout is piped", () => {
    const stdout = fakeTty({ isTTY: false });
    const stdin = fakeTty({ fd: 0 });
    const queriedFds: number[] = [];
    const resize = resizeSubscription();

    installLiveHostTtyDimensions({
      stdin,
      stdout,
      readWindowSize: (fd) => {
        queriedFds.push(fd);
        return { columns: 99, rows: 25 };
      },
      subscribeToResize: resize.subscribe,
    });

    expect({ columns: stdout.columns, rows: stdout.rows }).toEqual({ columns: 99, rows: 25 });
    resize.resize();
    expect(queriedFds).toEqual([0, 0]);
  });

  it("retries after an invalid initial refresh and retains the last valid pair", () => {
    const stdout = fakeTty();
    const stdin = fakeTty({ fd: 0 });
    const resize = resizeSubscription();
    let size: { columns: number; rows: number } | undefined;

    installLiveHostTtyDimensions({
      stdin,
      stdout,
      readWindowSize: () => size,
      subscribeToResize: resize.subscribe,
    });

    expect({ columns: stdout.columns, rows: stdout.rows }).toEqual({ columns: 80, rows: 24 });
    size = { columns: 100, rows: 30 };
    resize.resize();
    expect({ columns: stdout.columns, rows: stdout.rows }).toEqual(size);
    size = { columns: 0, rows: 20 };
    resize.resize();
    expect({ columns: stdout.columns, rows: stdout.rows }).toEqual({ columns: 100, rows: 30 });
  });

  it("emits one stream resize only when the published pair changes", () => {
    const events: string[] = [];
    const stdout = fakeTty({ emit: (event) => events.push(event) });
    const stdin = fakeTty({ fd: 0 });
    const resize = resizeSubscription();
    let size = { columns: 80, rows: 24 };

    installLiveHostTtyDimensions({
      stdin,
      stdout,
      readWindowSize: () => size,
      subscribeToResize: resize.subscribe,
    });
    resize.resize();
    size = { columns: 100, rows: 30 };
    resize.resize();

    expect(events).toEqual(["resize"]);
  });

  it("does not partially patch unsupported streams", () => {
    const stdout = fakeTty();
    const stdin = fakeTty({ fd: 0 });
    const resize = resizeSubscription();
    Object.defineProperty(stdout, "columns", {
      configurable: false,
      value: stdout.columns,
      writable: true,
    });
    const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, "columns");

    installLiveHostTtyDimensions({
      stdin,
      stdout,
      readWindowSize: () => ({ columns: 100, rows: 30 }),
      subscribeToResize: resize.subscribe,
    });

    expect(Object.getOwnPropertyDescriptor(stdout, "columns")).toEqual(columnsDescriptor);
    expect(stdout.rows).toBe(24);
    expect(resize.subscriptions()).toBe(0);
  });

  it("rolls back a mid-update descriptor failure and retries later", () => {
    const target = fakeTty();
    let rejectRows = true;
    const stdout = new Proxy(target, {
      defineProperty(object, property, descriptor) {
        if (property === "rows" && rejectRows && descriptor.value === 30) {
          throw new Error("rows unavailable");
        }
        return Reflect.defineProperty(object, property, descriptor);
      },
    });
    const resize = resizeSubscription();

    installLiveHostTtyDimensions({
      stdin: fakeTty({ fd: 0 }),
      stdout,
      readWindowSize: () => ({ columns: 100, rows: 30 }),
      subscribeToResize: resize.subscribe,
    });

    expect({ columns: stdout.columns, rows: stdout.rows }).toEqual({ columns: 80, rows: 24 });
    rejectRows = false;
    resize.resize();
    expect({ columns: stdout.columns, rows: stdout.rows }).toEqual({ columns: 100, rows: 30 });
  });

  it("keeps one HMR subscription while updating its refresh closure", () => {
    const stdout = fakeTty();
    const stdin = fakeTty({ fd: 0 });
    const resize = resizeSubscription();
    let replacementSize = { columns: 70, rows: 20 };

    installLiveHostTtyDimensions({
      stdin,
      stdout,
      readWindowSize: () => ({ columns: 110, rows: 33 }),
      subscribeToResize: resize.subscribe,
    });
    installLiveHostTtyDimensions({
      stdin,
      stdout,
      readWindowSize: () => replacementSize,
      subscribeToResize: resize.subscribe,
    });

    expect(resize.subscriptions()).toBe(1);
    expect({ columns: stdout.columns, rows: stdout.rows }).toEqual(replacementSize);
    replacementSize = { columns: 90, rows: 28 };
    resize.resize();
    expect({ columns: stdout.columns, rows: stdout.rows }).toEqual(replacementSize);
  });
});
