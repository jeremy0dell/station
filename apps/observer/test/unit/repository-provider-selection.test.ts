import type { RepositoryProvider, RepositoryRemote } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { selectRepositoryProvider } from "../../src/metadata/repositoryProviderSelection";

const remote: RepositoryRemote = {
  host: "forge.example",
  owner: "example",
  repo: "web",
};

describe("repository provider selection", () => {
  it("returns undefined when no provider supports the remote", () => {
    const provider = fakeRepositoryProvider("other", () => false);

    expect(selectRepositoryProvider(remote, [provider])).toBeUndefined();
  });

  it("selects a provider without relying on its ID", () => {
    const provider = fakeRepositoryProvider("forge", (candidate) => candidate.host === remote.host);

    expect(selectRepositoryProvider(remote, [provider])).toBe(provider);
  });

  it("rejects overlapping provider support", () => {
    const providers = [
      fakeRepositoryProvider("forge", () => true),
      fakeRepositoryProvider("other-forge", () => true),
    ];
    let thrown: unknown;

    try {
      selectRepositoryProvider(remote, providers);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual({
      tag: "RepositoryProviderError",
      code: "REPOSITORY_PROVIDER_AMBIGUOUS",
      message: "More than one repository provider supports this remote.",
      hint: "Ensure repository provider remote-support rules do not overlap.",
    });
  });
});

function fakeRepositoryProvider(
  id: string,
  supportsRemote: (remote: RepositoryRemote) => boolean,
): RepositoryProvider {
  return {
    id,
    supportsRemote,
    capabilities: () => ({
      canDiscoverPullRequests: true,
      canReadChecks: true,
      canUseCliAuth: false,
    }),
    health: async () => ({
      providerId: id,
      providerType: "repository",
      status: "unknown",
      lastCheckedAt: "2026-05-20T12:00:00.000Z",
      capabilities: {
        canDiscoverPullRequests: true,
        canReadChecks: true,
        canUseCliAuth: false,
      },
    }),
    discoverPullRequest: async () => null,
    readChecks: async () => null,
  };
}
