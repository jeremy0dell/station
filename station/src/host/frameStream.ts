import type { HostFrame } from "@station/host";

export type FrameStream = {
  frames: AsyncIterable<HostFrame>;
  push(frame: HostFrame): void;
  end(): void;
};

const MAX_PENDING_BYTES = 1024 * 1024;

type PendingPull = {
  resolve(result: IteratorResult<HostFrame>): void;
  reject(error: Error): void;
};

/**
 * Normal end drains queued frames. Iterator return or overflow releases the attachment.
 * Overflow rejects pending reads; the PTY survives for replay through a new attachment.
 */
export function createFrameStream(onReturn: () => void): FrameStream {
  const queue: Array<{ frame: HostFrame; bytes: number }> = [];
  const waiters: PendingPull[] = [];
  let pendingBytes = 0;
  let ended = false;
  let released = false;
  let failure: Error | undefined;

  const release = (): void => {
    if (released) return;
    released = true;
    onReturn();
  };
  const drain = (): void => {
    while (waiters.length > 0 && (queue.length > 0 || ended)) {
      const waiter = waiters.shift();
      if (waiter === undefined) break;
      if (failure !== undefined) {
        waiter.reject(failure);
        continue;
      }
      const item = queue.shift();
      if (item === undefined) {
        waiter.resolve({ done: true, value: undefined });
      } else {
        pendingBytes -= item.bytes;
        waiter.resolve({ done: false, value: item.frame });
      }
    }
  };

  return {
    push: (frame) => {
      if (ended) return;
      // Charge control frames and JSON escaping too, so empty-data floods remain bounded.
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      if (pendingBytes + bytes > MAX_PENDING_BYTES) {
        failure = new Error("Host attachment output exceeded 1 MiB; reconnect to recover terminal history.");
        ended = true;
        queue.length = 0;
        pendingBytes = 0;
        release();
        drain();
        return;
      }
      queue.push({ frame, bytes });
      pendingBytes += bytes;
      drain();
    },
    end: () => {
      ended = true;
      drain();
    },
    frames: {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise((resolve, reject) => {
          waiters.push({ resolve, reject });
          drain();
        }),
        return: () => {
          ended = true;
          queue.length = 0;
          pendingBytes = 0;
          release();
          drain();
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    },
  };
}
