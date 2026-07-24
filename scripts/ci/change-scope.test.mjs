import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyChangedPaths,
  DOCUMENTATION_ONLY_SCOPE,
  FULL_SCOPE,
  isDocumentationPath,
} from "./change-scope.mjs";

describe("change scope", () => {
  it("recognizes documentation paths without treating workflow YAML as documentation", () => {
    assert.equal(isDocumentationPath("docs/development.md"), true);
    assert.equal(isDocumentationPath("docs/assets/setup.png"), true);
    assert.equal(isDocumentationPath("AGENTS.md"), true);
    assert.equal(isDocumentationPath("packages/client/README.mdx"), true);
    assert.equal(isDocumentationPath(".github/pull_request_template.md"), true);
    assert.equal(isDocumentationPath(".github/workflows/standard-ci.yml"), false);
  });

  it("classifies documentation-only changes", () => {
    assert.equal(
      classifyChangedPaths(["docs/architecture.md", "docs/setup-architecture.md", "AGENTS.md"]),
      DOCUMENTATION_ONLY_SCOPE,
    );
  });

  it("fails closed for empty or mixed changes", () => {
    assert.equal(classifyChangedPaths([]), FULL_SCOPE);
    assert.equal(classifyChangedPaths(["docs/development.md", "apps/cli/src/main.ts"]), FULL_SCOPE);
  });
});
