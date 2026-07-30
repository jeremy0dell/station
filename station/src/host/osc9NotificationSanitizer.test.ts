import { describe, expect, it } from "bun:test";
import { createOsc9NotificationSanitizer } from "./osc9NotificationSanitizer.js";

describe("createOsc9NotificationSanitizer", () => {
  for (const [label, terminator] of [
    ["BEL", "\x07"],
    ["ST", "\x1b\\"],
    ["C1 ST", "\x9c"],
  ] as const) {
    it(`strips a fragmented OSC 9 payload terminated by ${label}`, () => {
      const sanitizer = createOsc9NotificationSanitizer();

      const events = [
        ...sanitizer.write("before\x1b]"),
        ...sanitizer.write("9;approval for "),
        ...sanitizer.write(`sensitive command${terminator}after`),
      ];

      expect(events).toEqual([
        { type: "data", data: "before" },
        { type: "data", data: "\x1b]9;" },
        { type: "data", data: terminator },
        { type: "notification" },
        { type: "data", data: "after" },
      ]);
      expect(JSON.stringify(events)).not.toContain("sensitive command");
    });
  }

  it("supports C1 OSC and leaves neighboring controls byte-for-byte unchanged", () => {
    const sanitizer = createOsc9NotificationSanitizer();
    const input = "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\x9d9;secret\x9c\x1b[31mred";
    const events = sanitizer.write(input);

    expect(events).toEqual([
      {
        type: "data",
        data: "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\x9d9;\x9c",
      },
      { type: "notification" },
      { type: "data", data: "\x1b[31mred" },
    ]);
  });

  it("preserves fragmented non-OSC-9 candidates exactly", () => {
    const sanitizer = createOsc9NotificationSanitizer();
    const events = [
      ...sanitizer.write("a\x1b]"),
      ...sanitizer.write("90;ordinary\x07b\x9d"),
      ...sanitizer.write("8;title\x9c"),
      ...sanitizer.flush(),
    ];

    expect(events.filter((event) => event.type === "data").map((event) => event.data).join(""))
      .toBe("a\x1b]90;ordinary\x07b\x9d8;title\x9c");
    expect(events.some((event) => event.type === "notification")).toBe(false);
  });
});
