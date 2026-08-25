import { describe, expect, it } from "vitest";
import {
  backspaceEditableText,
  clampEditableTextCursor,
  deleteEditableText,
  insertEditableText,
  moveEditableTextCursor,
} from "../../../src/components/EditableTextInput/editing.js";

describe("editable text input graphemes", () => {
  it("moves across whole narrow, wide, combining, and emoji graphemes", () => {
    const value = "A界e\u0301🙂B";
    const cursors: number[] = [];
    let state = { value, cursor: value.length };

    for (let index = 0; index < 5; index += 1) {
      state = moveEditableTextCursor(state, -1);
      cursors.push(state.cursor);
    }

    expect(cursors).toEqual([6, 4, 2, 1, 0]);
  });

  it("deletes and inserts only at grapheme boundaries", () => {
    const value = "A界e\u0301🙂B";

    expect(backspaceEditableText({ value, cursor: 6 })).toEqual({
      value: "A界e\u0301B",
      cursor: 4,
    });
    expect(backspaceEditableText({ value, cursor: 4 })).toEqual({
      value: "A界🙂B",
      cursor: 2,
    });
    expect(deleteEditableText({ value, cursor: 2 })).toEqual({
      value: "A界🙂B",
      cursor: 2,
    });
    expect(insertEditableText({ value, cursor: 3 }, "Z")).toEqual({
      value: "A界Ze\u0301🙂B",
      cursor: 3,
    });
    expect(clampEditableTextCursor(3, value)).toBe(2);

    const family = "👨‍👩‍👧‍👦";
    expect(backspaceEditableText({ value: `A${family}B`, cursor: 1 + family.length })).toEqual({
      value: "AB",
      cursor: 1,
    });
  });
});
