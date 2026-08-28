import { WriteStream } from "node:tty";

type HostTtyStream = {
  fd?: number;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
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
};

const installationMarker = Symbol.for("station.liveHostTtyDimensions.v1");

type MarkedHostTtyStream = HostTtyStream & {
  [installationMarker]?: true;
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

function refreshSizeFor(stream: HostTtyStream & { fd: number }): (() => WindowSize | undefined) | undefined {
  const selectedRefresh = (stream as RefreshableHostTtyStream)._refreshSize;
  // Bun's WriteStream implementation is the native TIOCGWINSZ bridge, including for stdin.
  const prototypeRefresh = (WriteStream.prototype as unknown as RefreshableHostTtyStream)
    ._refreshSize;
  const refreshSize = selectedRefresh ?? prototypeRefresh;
  if (refreshSize === undefined) {
    return undefined;
  }

  // Bun's refresh method reads `this.columns`/`this.rows`; keep those backing
  // values off process.stdout so the live accessors cannot recurse.
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

/**
 * Makes OpenTUI's process.stdout size sample the host PTY before its SIGWINCH
 * handler captures a resize; this intentionally installs no second resize loop.
 */
export function installLiveHostTtyDimensions(
  options: LiveHostTtyDimensionsOptions = {},
): void {
  const stdout = (options.stdout ?? process.stdout) as MarkedHostTtyStream;
  if (stdout[installationMarker] === true) {
    return;
  }

  const stdin = options.stdin ?? process.stdin;
  const source = usableTty(stdout)
    ? stdout
    : usableTty(stdin)
      ? stdin
      : undefined;
  if (source === undefined || !Object.isExtensible(stdout)) {
    return;
  }
  const markerDescriptor = Object.getOwnPropertyDescriptor(stdout, installationMarker);
  if (markerDescriptor !== undefined && markerDescriptor.configurable !== true) {
    return;
  }

  const readSize = options.readWindowSize ?? refreshSizeFor(source);
  if (readSize === undefined) {
    return;
  }

  let lastSize: WindowSize | undefined;
  const refresh = (): void => {
    try {
      const nextSize = readSize(source.fd);
      if (validWindowSize(nextSize)) {
        lastSize = { columns: nextSize.columns, rows: nextSize.rows };
      }
    } catch {
      // Keep the last known-good dimensions when a transient ioctl fails.
    }
  };
  refresh();
  if (lastSize === undefined) {
    return;
  }

  if (!canReplaceDimension(stdout, "columns") || !canReplaceDimension(stdout, "rows")) {
    return;
  }

  const columnsDescriptor = {
    configurable: true,
    enumerable: true,
    get: (): number => {
      refresh();
      return lastSize?.columns ?? 80;
    },
    set: () => undefined,
  };
  const rowsDescriptor = {
    configurable: true,
    enumerable: true,
    get: (): number => {
      refresh();
      return lastSize?.rows ?? 24;
    },
    set: () => undefined,
  };

  try {
    Object.defineProperties(stdout, {
      columns: columnsDescriptor,
      rows: rowsDescriptor,
      [installationMarker]: {
        configurable: false,
        enumerable: false,
        value: true,
        writable: false,
      },
    });
  } catch {
    // A host stream can be replaced by an embedding runtime; leave it intact.
  }
}
