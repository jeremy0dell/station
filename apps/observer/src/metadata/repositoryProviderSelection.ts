import type { RepositoryRemote, SafeError } from "@station/contracts";

type RepositoryProviderSelectionCandidate = {
  supportsRemote(remote: RepositoryRemote): boolean;
};

/**
 * POLICY
 *
 * Selects the sole repository adapter that supports a remote and rejects
 * overlapping support rules.
 */
export function selectRepositoryProvider<Provider extends RepositoryProviderSelectionCandidate>(
  remote: RepositoryRemote,
  providers: Iterable<Provider>,
): Provider | undefined {
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
