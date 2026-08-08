import type { HostFrame } from "@station/host";

export type FrameStream = {
  frames: AsyncIterable<HostFrame>;
  push(frame: HostFrame): void;
  end(): void;
};

/** A pull-based frame stream fed by `push`/`end`; `frames.return()` runs onReturn. */
export function createFrameStream(onReturn: () => void): FrameStream {
  const queue: HostFrame[] = [];
  const waiters: Array<(result: IteratorResult<HostFrame>) => void> = [];
  let ended = false;

  const drain = () => {
    while (waiters.length > 0 && (queue.length > 0 || ended)) {
      const waiter = waiters.shift();
      if (waiter === undefined) {
        break;
      }
      const next = queue.shift();
      waiter(next === undefined ? { done: true, value: undefined } : { done: false, value: next });
    }
  };

  return {
    push: (frame) => {
      queue.push(frame);
      drain();
    },
    end: () => {
      ended = true;
      drain();
    },
    frames: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<HostFrame>>((resolve) => {
            const next = queue.shift();
            if (next !== undefined) {
              resolve({ done: false, value: next });
              return;
            }
            if (ended) {
              resolve({ done: true, value: undefined });
              return;
            }
            waiters.push(resolve);
          }),
        return: () => {
          ended = true;
          onReturn();
          drain();
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    },
  };
}
