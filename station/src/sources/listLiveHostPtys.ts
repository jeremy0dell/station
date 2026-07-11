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

export type ListLiveHostPtysDeps = {
  /** Test seam; production dials the host unix socket. */
  createClient?: (socketPath: string) => ListClient;
  timeoutMs?: number;
  expectedBuildVersion?: string;
};

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
): Promise<readonly HostListEntry[] | undefined> {
  const health = await client.health();
  const compatibility = classifyHostCompatibility(health, expectedBuildVersion);

  switch (compatibility.action) {
    case "reuse":
      return client.list();
    case "replace":
      state.incompatibleHostDetected = true;
      await client.stopIfIdle(expectedBuildVersion);
      return undefined;
    case "refuse":
      state.incompatibleHostDetected = true;
      assertHostReusable(health, expectedBuildVersion);
      return undefined;
  }
}

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
  const operation = negotiateHostPtys(client, expectedBuildVersion, state);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      if (state.incompatibleHostDetected) {
        reject(hostCompatibilityUnconfirmed());
      } else {
        resolve(undefined);
      }
    }, timeoutMs);
  });

  try {
    // Promise.race observes a losing operation's late rejection after the timeout settles.
    return await Promise.race([operation, timeout]);
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
}
