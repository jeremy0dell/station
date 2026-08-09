export type UpdateOperationOptions = {
  signal?: AbortSignal;
};

/**
 * Defines one independently composable update channel as a local detection, remote plan,
 * and mutation lifecycle.
 */
export interface UpdateChannel<Detection, Plan, Report> {
  detect(options?: UpdateOperationOptions): Promise<Detection | undefined>;
  plan(detection: Detection, options?: UpdateOperationOptions): Promise<Plan>;
  apply(plan: Plan, options?: UpdateOperationOptions): Promise<Report>;
}
