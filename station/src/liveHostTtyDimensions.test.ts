import { describe, expect, it } from "bun:test";
import { installLiveHostTtyDimensions } from "./liveHostTtyDimensions.js";

type FakeTty = {
  columns: number;
  fd: number;
  isTTY: boolean;
  rows: number;
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

describe("installLiveHostTtyDimensions", () => {
  it("prefers a TTY stdout and reads fresh dimensions", () => {
    const stdout = fakeTty({ fd: 1 });
    const stdin = fakeTty({ fd: 0 });
    let size = { columns: 120, rows: 40 };
    const queriedFds: number[] = [];

    installLiveHostTtyDimensions({
      stdin,
      stdout,
      readWindowSize: (fd) => {
        queriedFds.push(fd);
        return size;
      },
    });

    expect(stdout.columns).toBe(120);
    expect(stdout.rows).toBe(40);
    size = { columns: 60, rows: 18 };
    expect(stdout.columns).toBe(60);
    expect(stdout.rows).toBe(18);
    expect(queriedFds.every((fd) => fd === 1)).toBe(true);
  });

  it("refreshes through the stream's native size method", () => {
    const stdout = fakeTty() as FakeTty & { _refreshSize: () => void };
    const stdin = fakeTty({ fd: 0 });
    let size = { columns: 118, rows: 38 };
    stdout._refreshSize = function (this: FakeTty): void {
      this.columns = size.columns;
      this.rows = size.rows;
    };

    installLiveHostTtyDimensions({ stdin, stdout });

    expect(stdout.columns).toBe(118);
    expect(stdout.rows).toBe(38);
    size = { columns: 62, rows: 17 };
    expect(stdout.columns).toBe(62);
    expect(stdout.rows).toBe(17);
  });

  it("uses a TTY stdin when stdout is piped", () => {
    const stdout = fakeTty({ isTTY: false });
    const stdin = fakeTty({ fd: 0 });
    const queriedFds: number[] = [];

    installLiveHostTtyDimensions({
      stdin,
      stdout,
      readWindowSize: (fd) => {
        queriedFds.push(fd);
        return { columns: 99, rows: 25 };
      },
    });

    expect(stdout.columns).toBe(99);
    expect(stdout.rows).toBe(25);
    expect(queriedFds).toEqual([0, 0, 0]);
  });

  it("retains the last valid pair after an invalid or failed refresh", () => {
    const stdout = fakeTty();
    const stdin = fakeTty({ fd: 0 });
    let size: { columns: number; rows: number } | undefined = { columns: 100, rows: 30 };

    installLiveHostTtyDimensions({
      stdin,
      stdout,
      readWindowSize: () => size,
    });

    size = { columns: 0, rows: 20 };
    expect(stdout.columns).toBe(100);
    expect(stdout.rows).toBe(30);
    size = undefined;
    expect(stdout.columns).toBe(100);
    expect(stdout.rows).toBe(30);
  });

  it("does not partially patch unsupported streams or add signal listeners", () => {
    const stdout = fakeTty();
    const stdin = fakeTty({ fd: 0 });
    Object.defineProperty(stdout, "columns", {
      configurable: false,
      value: stdout.columns,
      writable: true,
    });
    const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, "columns");
    const sigwinchListeners = process.listenerCount("SIGWINCH");

    installLiveHostTtyDimensions({
      stdin,
      stdout,
      readWindowSize: () => ({ columns: 100, rows: 30 }),
    });

    expect(Object.getOwnPropertyDescriptor(stdout, "columns")).toEqual(columnsDescriptor);
    expect(stdout.rows).toBe(24);
    expect(process.listenerCount("SIGWINCH")).toBe(sigwinchListeners);
  });

  it("is idempotent for HMR and absorbs cache writes", () => {
    const stdout = fakeTty();
    const stdin = fakeTty({ fd: 0 });
    let queries = 0;
    const readWindowSize = () => {
      queries += 1;
      return { columns: 110, rows: 33 };
    };

    installLiveHostTtyDimensions({ stdin, stdout, readWindowSize });
    const columnsDescriptor = Object.getOwnPropertyDescriptor(stdout, "columns");
    const rowsDescriptor = Object.getOwnPropertyDescriptor(stdout, "rows");
    const initialQueries = queries;
    installLiveHostTtyDimensions({
      stdin,
      stdout,
      readWindowSize: () => ({ columns: 70, rows: 20 }),
    });
    stdout.columns = 70;
    stdout.rows = 20;

    expect(Object.getOwnPropertyDescriptor(stdout, "columns")?.get).toBe(columnsDescriptor?.get);
    expect(Object.getOwnPropertyDescriptor(stdout, "rows")?.get).toBe(rowsDescriptor?.get);
    expect(queries).toBe(initialQueries);
    expect(stdout.columns).toBe(110);
    expect(stdout.rows).toBe(33);
    expect(queries).toBe(initialQueries + 2);
  });
});
