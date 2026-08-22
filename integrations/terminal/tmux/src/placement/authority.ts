import { randomUUID } from "node:crypto";
import type { TmuxPrivateProof } from "./types.js";

type TmuxPlacementAuthority = {
  id: string;
  value: TmuxPrivateProof;
  expiresAt: Date;
};

export class TmuxPlacementAuthorityStore {
  readonly #entries = new Map<string, TmuxPlacementAuthority>();
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #capacity: number;

  constructor(options: { now?: () => Date; newId?: () => string; capacity?: number } = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => `authority_${randomUUID()}`);
    this.#capacity = options.capacity ?? 256;
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity <= 0) {
      throw new Error("Tmux placement authority capacity must be a positive integer.");
    }
  }

  issue(value: TmuxPrivateProof, ttlMs: number): TmuxPlacementAuthority {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Tmux placement authority TTL must be a positive integer.");
    }
    this.#prune();
    while (this.#entries.size >= this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
    const authority: TmuxPlacementAuthority = {
      id: this.#newId(),
      value,
      expiresAt: new Date(this.#now().getTime() + ttlMs),
    };
    this.#entries.set(authority.id, authority);
    return authority;
  }

  get(id: string): TmuxPlacementAuthority | undefined {
    const authority = this.#entries.get(id);
    if (authority === undefined) return undefined;
    if (authority.expiresAt.getTime() <= this.#now().getTime()) {
      this.#entries.delete(id);
      return undefined;
    }
    return authority;
  }

  consume(id: string): TmuxPlacementAuthority | undefined {
    const authority = this.get(id);
    if (authority !== undefined) this.#entries.delete(id);
    return authority;
  }

  #prune(): void {
    for (const [id, authority] of this.#entries) {
      if (authority.expiresAt.getTime() <= this.#now().getTime()) {
        this.#entries.delete(id);
      }
    }
  }
}
