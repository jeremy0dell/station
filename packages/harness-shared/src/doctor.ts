import type { ProviderDoctorCheck, ProviderHealth } from "@station/contracts";
import { safeErrorFromUnknown } from "@station/runtime";

/** Projects a fresh health probe onto one doctor check, carrying lastError when unavailable. */
export function healthDoctorCheck(
  health: ProviderHealth,
  text: { name: string; ok: string; error: string },
): ProviderDoctorCheck {
  if (health.status === "healthy") {
    return { name: text.name, status: "ok", message: text.ok };
  }
  const check: ProviderDoctorCheck = { name: text.name, status: "error", message: text.error };
  if (health.lastError !== undefined) {
    check.error = health.lastError;
  }
  return check;
}

/** Runs a provider hook doctor and converts a thrown failure into an error check. */
export async function hookDoctorCheck<
  TResult extends { status: "ok" | "warn"; message: string },
>(input: {
  name: string;
  run: () => Promise<TResult>;
  describe: (result: TResult) => string;
  failure: { tag: string; code: string; message: string; provider: string };
}): Promise<ProviderDoctorCheck> {
  try {
    const result = await input.run();
    return { name: input.name, status: result.status, message: input.describe(result) };
  } catch (cause) {
    return {
      name: input.name,
      status: "error",
      message: input.failure.message,
      error: safeErrorFromUnknown(cause, input.failure),
    };
  }
}
