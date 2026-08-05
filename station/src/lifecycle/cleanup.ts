export type CleanupStep = () => void | Promise<void>;

/** Invoke a cleanup without allowing a synchronous throw to skip later releases. */
export function invokeCleanup(step: CleanupStep): Promise<void> {
  try {
    return Promise.resolve(step());
  } catch (error: unknown) {
    return Promise.reject(error);
  }
}

/** Start every cleanup immediately and reject once with all failures after settlement. */
export function settleCleanupSteps(
  steps: readonly CleanupStep[],
  message: string,
): Promise<void> {
  return settleCleanupPromises(steps.map(invokeCleanup), message);
}

/** Reject once with all failures after every supplied cleanup has settled. */
export async function settleCleanupPromises(
  settlements: readonly Promise<void>[],
  message: string,
): Promise<void> {
  const outcomes = await Promise.allSettled(settlements);
  const failures: unknown[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      failures.push(outcome.reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, message);
  }
}

/** Start non-extendable best-effort cleanup with every rejection observed. */
export function startCleanupStepsBestEffort(steps: readonly CleanupStep[]): void {
  for (const step of steps) {
    void invokeCleanup(step).catch(() => {
      // A process exit event cannot await or surface asynchronous cleanup failure.
    });
  }
}
