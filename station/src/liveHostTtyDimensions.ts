import { WriteStream } from "node:tty";

type HostTtyStream = {
  fd?: number;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  emit?: (event: "resize") => unknown;
};

type WindowSize = {
  columns: number;
  rows: number;
};

type TtySizeProbe = {
  fd: number;
  columns: number;
  rows: number;
  emit: (...args: unknown[]) => unknown;
};

type RefreshSize = (this: TtySizeProbe) => void;

type LiveHostTtyDimensionsOptions = {
  stdout?: HostTtyStream;
  stdin?: HostTtyStream;
  readWindowSize?: (fd: number) => WindowSize | undefined;
  subscribeToResize?: (listener: () => void) => void;
};

type LiveHostTtyInstallation = {
  refresh: () => void;
};

const installationMarker = Symbol.for("station.liveHostTtyDimensions.v2");

type MarkedHostTtyStream = HostTtyStream & {
  [installationMarker]?: LiveHostTtyInstallation;
};

type RefreshableHostTtyStream = HostTtyStream & {
  _refreshSize?: RefreshSize;
};

function positiveInteger(value: number | undefined): value is number {
  if (value === undefined) {
    return false;
  }
  return Number.isInteger(value) && value > 0;
}

function validWindowSize(value: WindowSize | undefined): value is WindowSize {
  if (value === undefined) {
    return false;
  }
  return positiveInteger(value.columns) && positiveInteger(value.rows);
}

function usableTty(stream: HostTtyStream): stream is HostTtyStream & { fd: number } {
  if (stream.isTTY !== true || stream.fd === undefined) {
    return false;
  }
  return Number.isInteger(stream.fd) && stream.fd >= 0;
}

function refreshSizeFor(
  stream: HostTtyStream & { fd: number },
): (() => WindowSize | undefined) | undefined {
  const selectedRefresh = (stream as RefreshableHostTtyStream)._refreshSize;
  // Bun's WriteStream implementation is the native TIOCGWINSZ bridge, including for stdin.
  const prototypeRefresh = (WriteStream.prototype as unknown as RefreshableHostTtyStream)
    ._refreshSize;
  const refreshSize = selectedRefresh ?? prototypeRefresh;
  if (refreshSize === undefined) {
    return undefined;
  }

  const probe: TtySizeProbe = {
    columns: stream.columns ?? 0,
    emit: () => undefined,
    fd: stream.fd,
    rows: stream.rows ?? 0,
  };
  return () => {
    refreshSize.call(probe);
    return { columns: probe.columns, rows: probe.rows };
  };
}

function canReplaceDimension(stream: object, property: "columns" | "rows"): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(stream, property);
  return descriptor === undefined || descriptor.configurable === true;
}

function restoreDescriptor(
  stream: object,
  property: "columns" | "rows",
  descriptor: PropertyDescriptor | undefined,
): void {
  try {
    if (descriptor === undefined) {
      Reflect.deleteProperty(stream, property);
    } else {
      Object.defineProperty(stream, property, descriptor);
    }
  } catch {
    // The supported process streams accept rollback; an exotic embedding may refuse it.
  }
}

function applyWindowSize(stream: HostTtyStream, nextSize: WindowSize): void {
  if (!canReplaceDimension(stream, "columns") || !canReplaceDimension(stream, "rows")) {
    return;
  }

  const columnsDescriptor = Object.getOwnPropertyDescriptor(stream, "columns");
  const rowsDescriptor = Object.getOwnPropertyDescriptor(stream, "rows");
  const changed = stream.columns !== nextSize.columns || stream.rows !== nextSize.rows;
  try {
    Object.defineProperties(stream, {
      columns: {
        configurable: true,
        enumerable: columnsDescriptor?.enumerable ?? true,
        value: nextSize.columns,
        writable: true,
      },
      rows: {
        configurable: true,
        enumerable: rowsDescriptor?.enumerable ?? true,
        value: nextSize.rows,
        writable: true,
      },
    });
  } catch {
    restoreDescriptor(stream, "columns", columnsDescriptor);
    restoreDescriptor(stream, "rows", rowsDescriptor);
    return;
  }

  if (changed) {
    stream.emit?.("resize");
  }
}

/**
 * Refreshes Bun's cached stdout geometry before OpenTUI handles each SIGWINCH.
 * One ioctl updates both dimensions and preserves the stream's resize event.
 */
export function installLiveHostTtyDimensions(
  options: LiveHostTtyDimensionsOptions = {},
): void {
  const stdout = (options.stdout ?? process.stdout) as MarkedHostTtyStream;
  const stdin = options.stdin ?? process.stdin;
  const source = usableTty(stdout)
    ? stdout
    : usableTty(stdin)
      ? stdin
      : undefined;
  if (source === undefined || !Object.isExtensible(stdout)) {
    return;
  }
  if (!canReplaceDimension(stdout, "columns") || !canReplaceDimension(stdout, "rows")) {
    return;
  }

  const readSize = options.readWindowSize ?? refreshSizeFor(source);
  if (readSize === undefined) {
    return;
  }

  const refresh = (): void => {
    let nextSize: WindowSize | undefined;
    try {
      nextSize = readSize(source.fd);
    } catch {
      // Keep the last known-good dimensions when a transient ioctl fails.
      return;
    }
    if (validWindowSize(nextSize)) {
      applyWindowSize(stdout, nextSize);
    }
  };

  const existing = stdout[installationMarker];
  if (existing !== undefined) {
    existing.refresh = refresh;
    refresh();
    return;
  }

  const installation: LiveHostTtyInstallation = { refresh };
  try {
    Object.defineProperty(stdout, installationMarker, {
      configurable: true,
      enumerable: false,
      value: installation,
      writable: false,
    });
    const subscribe =
      options.subscribeToResize ??
      ((listener: () => void): void => {
        process.prependListener("SIGWINCH", listener);
      });
    subscribe(() => installation.refresh());
  } catch {
    Reflect.deleteProperty(stdout, installationMarker);
    return;
  }
  refresh();
}
