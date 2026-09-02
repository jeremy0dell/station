import { OneShotAuthorityStore } from "@station/runtime";
import { describe, expect, it } from "vitest";

describe("OneShotAuthorityStore", () => {
  it("expires entries and consumes a valid authority exactly once", () => {
    let now = new Date("2026-08-20T12:00:00.000Z");
    let sequence = 0;
    const store = new OneShotAuthorityStore<string>({
      capacity: 2,
      now: () => now,
      newId: () => `authority_${++sequence}`,
    });

    const consumed = store.issue("first", 60_000);
    expect(store.get(consumed.id)?.value).toBe("first");
    expect(store.consume(consumed.id)?.value).toBe("first");
    expect(store.consume(consumed.id)).toBeUndefined();

    const expired = store.issue("second", 60_000);
    now = new Date("2026-08-20T12:01:00.000Z");
    expect(store.get(expired.id)).toBeUndefined();
  });

  it("evicts the oldest live entry at capacity", () => {
    let sequence = 0;
    const store = new OneShotAuthorityStore<string>({
      capacity: 2,
      newId: () => `authority_${++sequence}`,
    });

    const first = store.issue("first", 60_000);
    const second = store.issue("second", 60_000);
    const third = store.issue("third", 60_000);

    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(second.id)?.value).toBe("second");
    expect(store.get(third.id)?.value).toBe("third");
  });

  it("rejects invalid capacity and TTL", () => {
    expect(() => new OneShotAuthorityStore({ capacity: 0 })).toThrow(/positive integer/u);
    expect(() => new OneShotAuthorityStore({ capacity: 1.5 })).toThrow(/positive integer/u);

    const store = new OneShotAuthorityStore({ capacity: 1 });
    expect(() => store.issue("value", 0)).toThrow(/positive integer/u);
    expect(() => store.issue("value", 1.5)).toThrow(/positive integer/u);
  });
});
