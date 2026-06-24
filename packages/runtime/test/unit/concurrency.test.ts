import { forEachConcurrent } from "@station/runtime";
import { describe, expect, it } from "vitest";

describe("runtime concurrency helpers", () => {
  it("caps active work", async () => {
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];

    const run = forEachConcurrent([1, 2, 3, 4, 5], { concurrency: 2 }, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        release.push(resolve);
      });
      active -= 1;
    });

    await waitFor(() => release.length === 2);
    expect(maxActive).toBe(2);
    releaseAll(release);
    await waitFor(() => release.length === 2);
    expect(maxActive).toBe(2);
    releaseAll(release);
    await waitFor(() => release.length === 1);
    releaseAll(release);

    await run;
    expect(maxActive).toBe(2);
  });
});

function releaseAll(release: Array<() => void>): void {
  for (const resolve of release.splice(0)) {
    resolve();
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for predicate.");
}
