import { z } from "zod";
import { nonEmptyStringSchema } from "./shared.js";

export type UpdateArtifact = { version: string; revision?: string };

/** Strict installed or target Station build identity shared by the current update report and convergence-planning contracts. */
export const UpdateArtifactSchema = z
  .object({
    version: nonEmptyStringSchema,
    revision: nonEmptyStringSchema.optional(),
  })
  .strict()
  .transform(
    (artifact): UpdateArtifact => ({
      version: artifact.version,
      ...(artifact.revision === undefined ? {} : { revision: artifact.revision }),
    }),
  );
