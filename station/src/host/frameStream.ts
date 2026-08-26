import type { HostFrame } from "@station/host";

export type FrameStream = {
  frames: AsyncIterable<HostFrame>;
  push(frame: HostFrame): void;
  end(): void;
};

function frameIteratorResult(frame: HostFrame | undefined): IteratorResult<HostFrame> {
  if (frame === undefined) {
    return { done: true, value: undefined };
  }
  return { done: false, value: frame };
}

/** A pull-based frame stream fed by `push`/`end`; `frames.return()` runs onReturn. */
export function createFrameStream(onReturn: () => void): FrameStream {
  const queue: HostFrame[] = [];
  const waiters: Array<(result: IteratorResult<HostFrame>) => void> = [];
  let ended = false;

  // next() only parks; drain is the single path that completes a pull.
  const drain = (): void => {
    while (waiters.length > 0 && (queue.length > 0 || ended)) {
      const waiter = waiters.shift();
      if (waiter === undefined) {
        break;
      }
      waiter(frameIteratorResult(queue.shift()));
    }
  };
  const pullFrame = (): Promise<IteratorResult<HostFrame>> =>
    new Promise((resolve) => {
      waiters.push(resolve);
      drain();
    });

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
        next: pullFrame,
        return: () => {
          ended = true;
          onReturn();
          drain();
          return Promise.resolve(frameIteratorResult(undefined));
        },
      }),
    },
  };
}
