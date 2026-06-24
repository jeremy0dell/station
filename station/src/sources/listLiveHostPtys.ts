import { existsSync } from "node:fs";
import { createStationHostClient, type HostListEntry } from "@station/host";

/** One bounded `host.list` at boot. A missing socket, or a list that is slow or
 * rejects, yields `undefined` so restore stays cold rather than hanging the UI on
 * a host that isn't there. */
export const HOST_LIST_TIMEOUT_MS = 1000;

type ListClient = { list(): Promise<readonly HostListEntry[]>; dispose(): void };

export type ListLiveHostPtysDeps = {
  /** Test seam; production dials the host unix socket. */
  createClient?: (socketPath: string) => ListClient;
  timeoutMs?: number;
};

export async function listLiveHostPtys(
  socketPath: string,
  deps: ListLiveHostPtysDeps = {},
): Promise<readonly HostListEntry[] | undefined> {
  if (!existsSync(socketPath)) {
    return undefined;
  }
  const timeoutMs = deps.timeoutMs ?? HOST_LIST_TIMEOUT_MS;
  const client = (deps.createClient ?? ((path) => createStationHostClient({ socketPath: path })))(
    socketPath,
  );
  try {
    // .catch on the list promise (not just the await) so a rejection that lands
    // AFTER the timeout already won is still handled, never an unhandled rejection.
    const listed = client.list().catch(() => undefined);
    return await Promise.race([
      listed,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    ]);
  } finally {
    // Closes the socket — also cancels the in-flight list() on the timeout path.
    client.dispose();
  }
}
