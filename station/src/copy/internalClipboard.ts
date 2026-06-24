/** Station's own clipboard buffer — the `internal` copy sink and the source a
 * future "paste yank" binding would read. Survives for the app's lifetime. */
export type InternalClipboard = {
  get(): string | null;
  set(text: string): void;
};

export function createInternalClipboard(): InternalClipboard {
  let value: string | null = null;
  return {
    get: () => value,
    set: (text) => {
      value = text;
    },
  };
}
