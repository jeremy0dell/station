import { describe, expect, it } from "vitest";
import { snapshotLoadingContent } from "../../../src/components/Dashboard/content.js";

describe("snapshotLoadingContent", () => {
  it("describes reconnecting content without renderer spacer entries", () => {
    expect(snapshotLoadingContent(false, { state: "reconnecting", since: 1_000 })).toEqual({
      kind: "reconnecting",
      title: "waiting for observer",
      detail: "retrying connection",
      hint: "The dashboard will appear when the observer is ready.",
    });
  });

  it("describes unavailable and initial-loading states as semantic content", () => {
    expect(snapshotLoadingContent(false, { state: "connected" })).toEqual({
      kind: "unavailable",
      title: "observer snapshot unavailable",
      hint: "Check the error details and try refreshing when ready.",
    });
    expect(snapshotLoadingContent(true, { state: "connected" })).toEqual({
      kind: "loading",
      title: "Loading observer snapshot...",
    });
  });
});
