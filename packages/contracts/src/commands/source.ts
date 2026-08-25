import { z } from "zod";
import { nonEmptyStringSchema } from "../shared.js";

export const CommandSourceSchema = z
  .object({
    kind: z.enum(["branch", "pr", "manual"]),
    value: nonEmptyStringSchema,
  })
  .strict();
