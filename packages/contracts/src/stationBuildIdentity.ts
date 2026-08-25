import { z } from "zod";
/** Immutable content identity shared by every runtime artifact from one Station build. */
export const StationBuildIdentitySchema = z.string().regex(/^[0-9a-f]{64}$/u);
export type StationBuildIdentity = z.infer<typeof StationBuildIdentitySchema>;
