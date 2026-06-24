import { Effect } from "./effect.js";

export type ForEachConcurrentOptions = {
  concurrency: number;
};

export async function forEachConcurrent<T>(
  items: readonly T[],
  options: ForEachConcurrentOptions,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  await Effect.runPromise(
    Effect.forEach(
      items,
      (item, index) =>
        Effect.tryPromise({
          try: () => task(item, index),
          catch: (error) => error,
        }),
      { concurrency, discard: true },
    ),
  );
}
