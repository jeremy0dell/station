import { randomUUID } from "node:crypto";

/** One bounded, expiring authority whose value may be consumed exactly once. */
export type OneShotAuthority<T> = {
  id: string;
  value: T;
  expiresAt: Date;
};

/** Stores bounded short-lived authority with atomic one-shot consumption. */
export class OneShotAuthorityStore<T> {
  readonly #entries = new Map<string, OneShotAuthority<T>>();
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #capacity: number;

  constructor(options: { capacity: number; now?: () => Date; newId?: () => string }) {
    this.#capacity = options.capacity;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => `authority_${randomUUID()}`);
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity <= 0) {
      throw new Error("One-shot authority capacity must be a positive integer.");
    }
  }

  issue(value: T, ttlMs: number): OneShotAuthority<T> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("One-shot authority TTL must be a positive integer.");
    }
    this.#prune();
    while (this.#entries.size >= this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
    const authority: OneShotAuthority<T> = {
      id: this.#newId(),
      value,
      expiresAt: new Date(this.#now().getTime() + ttlMs),
    };
    this.#entries.set(authority.id, authority);
    return authority;
  }

  get(id: string): OneShotAuthority<T> | undefined {
    const authority = this.#entries.get(id);
    if (authority === undefined) return undefined;
    if (authority.expiresAt.getTime() <= this.#now().getTime()) {
      this.#entries.delete(id);
      return undefined;
    }
    return authority;
  }

  consume(id: string): OneShotAuthority<T> | undefined {
    const authority = this.get(id);
    if (authority !== undefined) this.#entries.delete(id);
    return authority;
  }

  #prune(): void {
    for (const [id, authority] of this.#entries) {
      if (authority.expiresAt.getTime() <= this.#now().getTime()) this.#entries.delete(id);
    }
  }
}
