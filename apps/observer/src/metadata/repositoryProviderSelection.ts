import type { RepositoryProvider, RepositoryRemote, SafeError } from "@station/contracts";

/**
 * POLICY
 *
 * Selects the sole repository adapter that supports a remote and rejects
 * overlapping support rules.
 */
export function selectRepositoryProvider(
  remote: RepositoryRemote,
  providers: Iterable<RepositoryProvider>,
): RepositoryProvider | undefined {
  const matches = Array.from(providers).filter((provider) => provider.supportsRemote(remote));
  if (matches.length > 1) {
    throw {
      tag: "RepositoryProviderError",
      code: "REPOSITORY_PROVIDER_AMBIGUOUS",
      message: "More than one repository provider supports this remote.",
      hint: "Ensure repository provider remote-support rules do not overlap.",
    } satisfies SafeError;
  }
  return matches[0];
}
