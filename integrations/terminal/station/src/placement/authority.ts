import { randomUUID } from "node:crypto";
import type { NativePrivateProof } from "./proof.js";

export const NATIVE_PLACEMENT_AUTHORITY_TTL_MS = 10 * 60 * 1000;
export const NATIVE_PLACEMENT_AUTHORITY_CAPACITY = 256;

export type NativePlacementAuthority = {
  id: string;
  value: NativePrivateProof;
  expiresAt: Date;
};

export class NativePlacementAuthorityStore {
  readonly #entries = new Map<string, NativePlacementAuthority>();
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #capacity: number;

  constructor(options: { now?: () => Date; newId?: () => string; capacity?: number } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => `authority_${randomUUID()}`);
    this.#capacity = options.capacity ?? NATIVE_PLACEMENT_AUTHORITY_CAPACITY;
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity <= 0) {
      throw new Error("Native placement authority capacity must be a positive integer.");
    }
  }

  issue(value: NativePrivateProof, ttlMs: number): NativePlacementAuthority {
    this.#prune();
    while (this.#entries.size >= this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
    const authority = {
      id: this.#newId(),
      value,
      expiresAt: new Date(this.#now().getTime() + ttlMs),
    };
    this.#entries.set(authority.id, authority);
    return authority;
  }

  get(id: string): NativePlacementAuthority | undefined {
    const authority = this.#entries.get(id);
    if (authority === undefined) return undefined;
    if (authority.expiresAt.getTime() <= this.#now().getTime()) {
      this.#entries.delete(id);
      return undefined;
    }
    return authority;
  }

  consume(id: string): NativePlacementAuthority | undefined {
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
