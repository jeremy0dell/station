import {
  SEMANTIC_COPY_MAX_SEPARATOR_SPACES,
  SemanticCopySnapshotSchema,
  STATION_TERMINAL_MAX_COLUMNS,
  STATION_TERMINAL_MAX_ROWS,
  STATION_TERMINAL_MAX_SCROLLBACK_ROWS,
} from "@station/contracts";
import { describe, expect, it } from "vitest";

describe("SemanticCopySnapshotSchema", () => {
  it("accepts bounded content-free rows", () => {
    expect(
      SemanticCopySnapshotSchema.parse({
        normal: [
          {
            row: STATION_TERMINAL_MAX_SCROLLBACK_ROWS + STATION_TERMINAL_MAX_ROWS - 1,
            leadingColumns: STATION_TERMINAL_MAX_COLUMNS,
            separatorSpaces: SEMANTIC_COPY_MAX_SEPARATOR_SPACES,
          },
        ],
        alternate: [],
      }),
    ).toBeDefined();
  });

  it("rejects duplicate rows and values outside the resource policy", () => {
    expect(
      SemanticCopySnapshotSchema.safeParse({
        normal: [
          { row: 0, leadingColumns: 0, separatorSpaces: 0 },
          { row: 0, leadingColumns: 1, separatorSpaces: 1 },
        ],
        alternate: [],
      }).success,
    ).toBe(false);
    expect(
      SemanticCopySnapshotSchema.safeParse({
        normal: [
          {
            row: STATION_TERMINAL_MAX_SCROLLBACK_ROWS + STATION_TERMINAL_MAX_ROWS,
            leadingColumns: STATION_TERMINAL_MAX_COLUMNS + 1,
            separatorSpaces: SEMANTIC_COPY_MAX_SEPARATOR_SPACES + 1,
          },
        ],
        alternate: [],
      }).success,
    ).toBe(false);
  });
});
