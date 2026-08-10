import { existsSync } from "node:fs";
import {
  assertHostReusable,
  classifyHostCompatibility,
  createStationHostClient,
  isStationHostCompatibilityError,
  stationHostSafeError,
  type HostHealthResult,
  type HostListEntry,
} from "@station/host";
import { stationBuildInfo } from "@station/runtime";

/** One bounded boot negotiation: reuse an exact host, stop an idle old build,
 * and let compatibility failures escape before Station can restore cold. */
export const HOST_LIST_TIMEOUT_MS = 1000;

type ListClient = {
  health(): Promise<HostHealthResult>;
  list(): Promise<readonly HostListEntry[]>;
  stopIfIdle(requestingBuildVersion: string): Promise<{ stopping: true }>;
  dispose(): void;
};

export type BusyHostHandoffInput = {
  socketPath: string;
  expectedBuildVersion: string;
};

export type ListLiveHostPtysDeps = {
  /** Test seam; production dials the host unix socket. */
  createClient?: (socketPath: string) => ListClient;
  timeoutMs?: number;
  expectedBuildVersion?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Runs only after bounded admission finds an eligible busy replacement Host. */
  handoffBusyHost?: (
    input: BusyHostHandoffInput,
  ) => Promise<readonly HostListEntry[]>;
};

type HostPtyNegotiation =
  | { kind: "listed"; entries: readonly HostListEntry[] }
  | { kind: "cold" }
  | { kind: "handoff"; refusal: unknown };

function hostCompatibilityUnconfirmed() {
  return stationHostSafeError(
    "HOST_VERSION_INCOMPATIBLE",
    "Station host upgrade could not be completed safely.",
    {
      hint:
        "The existing host and terminals were preserved. Retry, or reopen with the running build.",
    },
  );
}

async function negotiateHostPtys(
  client: ListClient,
  expectedBuildVersion: string,
  state: { incompatibleHostDetected: boolean },
  handoffEnabled: boolean,
): Promise<HostPtyNegotiation> {
  const health = await client.health();
  const compatibility = classifyHostCompatibility(health, expectedBuildVersion);

  switch (compatibility.action) {
    case "reuse":
      return { kind: "listed", entries: await client.list() };
    case "replace":
      state.incompatibleHostDetected = true;
      try {
        await client.stopIfIdle(expectedBuildVersion);
        return { kind: "cold" };
      } catch (error) {
        if (
          handoffEnabled &&
          isStationHostCompatibilityError(error) &&
          error.code === "HOST_UPGRADE_BLOCKED"
        ) {
          return { kind: "handoff", refusal: error };
        }
        throw error;
      }
    case "refuse":
      state.incompatibleHostDetected = true;
      assertHostReusable(health, expectedBuildVersion);
      return { kind: "cold" };
  }
}

/**
 * ADAPTER
 *
 * Lists reusable Host PTYs after bounded compatibility admission. Exact
 * `STATION_HOST_HANDOFF=1` may negotiate one busy same-protocol replacement
 * outside that bound; successor listing failures stay visible to prevent cold restore.
 */
export async function listLiveHostPtys(
  socketPath: string,
  deps: ListLiveHostPtysDeps = {},
): Promise<readonly HostListEntry[] | undefined> {
  if (!existsSync(socketPath)) {
    return undefined;
  }
  const timeoutMs = deps.timeoutMs ?? HOST_LIST_TIMEOUT_MS;
  const expectedBuildVersion = deps.expectedBuildVersion ?? stationBuildInfo().version;
  const client =
    deps.createClient?.(socketPath) ??
    createStationHostClient({ socketPath, expectedBuildVersion });
  const state = { incompatibleHostDetected: false };
  const operation = negotiateHostPtys(
    client,
    expectedBuildVersion,
    state,
    (deps.env ?? process.env).STATION_HOST_HANDOFF === "1",
  );
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HostPtyNegotiation>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      if (state.incompatibleHostDetected) {
        reject(hostCompatibilityUnconfirmed());
      } else {
        resolve({ kind: "cold" });
      }
    }, timeoutMs);
  });

  let result: HostPtyNegotiation;
  try {
    // Promise.race observes a losing operation's late rejection after the timeout settles.
    result = await Promise.race([operation, timeout]);
  } catch (error) {
    if (isStationHostCompatibilityError(error)) {
      throw error;
    }
    if (state.incompatibleHostDetected) {
      throw hostCompatibilityUnconfirmed();
    }
    return undefined;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    // Closes the socket — also cancels the in-flight list() on the timeout path.
    client.dispose();
  }

  switch (result.kind) {
    case "listed":
      return result.entries;
    case "cold":
      return undefined;
    case "handoff":
      if (deps.handoffBusyHost === undefined) {
        throw result.refusal;
      }
      return deps.handoffBusyHost({ socketPath, expectedBuildVersion });
  }
}
