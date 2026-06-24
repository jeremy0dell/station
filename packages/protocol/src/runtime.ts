export function unwrapBoundaryResult<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}
