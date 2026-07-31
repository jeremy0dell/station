import { z } from "zod";

/** Smallest PTY width supported by Station's native terminal paths. */
export const STATION_TERMINAL_MIN_COLUMNS = 2;
/** Smallest PTY height supported by Station's native terminal paths. */
export const STATION_TERMINAL_MIN_ROWS = 1;
/** Resource ceiling far above practical terminal widths, shared by Host wire validation. */
export const STATION_TERMINAL_MAX_COLUMNS = 1_000;
/** Resource ceiling far above practical terminal heights, shared by Host wire validation. */
export const STATION_TERMINAL_MAX_ROWS = 1_000;
/** Maximum normal-buffer history retained by Station's pane and Host terminal models. */
export const STATION_TERMINAL_MAX_SCROLLBACK_ROWS = 10_000;

/** Versioned v1 limit for spaces consumed at a cooperating renderer's wrap boundary. */
export const SEMANTIC_COPY_MAX_SEPARATOR_SPACES = 1_024;
const SEMANTIC_COPY_MAX_BUFFER_ROWS =
  STATION_TERMINAL_MAX_SCROLLBACK_ROWS + STATION_TERMINAL_MAX_ROWS;

const SemanticCopySnapshotEntrySchema = z
  .object({
    row: z
      .number()
      .int()
      .min(0)
      .max(SEMANTIC_COPY_MAX_BUFFER_ROWS - 1),
    leadingColumns: z.number().int().min(0).max(STATION_TERMINAL_MAX_COLUMNS),
    separatorSpaces: z.number().int().min(0).max(SEMANTIC_COPY_MAX_SEPARATOR_SPACES),
  })
  .strict();

const SemanticCopySnapshotRowsSchema = z
  .array(SemanticCopySnapshotEntrySchema)
  .max(SEMANTIC_COPY_MAX_BUFFER_ROWS)
  .superRefine((rows, context) => {
    const seen = new Set<number>();
    for (const [index, row] of rows.entries()) {
      if (seen.has(row.row)) {
        context.addIssue({
          code: "custom",
          path: [index, "row"],
          message: "Semantic-copy buffer rows must be unique.",
        });
      }
      seen.add(row.row);
    }
  });

/** Strict, content-free semantic-copy state shared by Station and Station Host. */
export const SemanticCopySnapshotSchema = z
  .object({
    normal: SemanticCopySnapshotRowsSchema,
    alternate: SemanticCopySnapshotRowsSchema,
  })
  .strict();

export type SemanticCopySnapshotEntry = z.infer<typeof SemanticCopySnapshotEntrySchema>;
export type SemanticCopySnapshot = z.infer<typeof SemanticCopySnapshotSchema>;
