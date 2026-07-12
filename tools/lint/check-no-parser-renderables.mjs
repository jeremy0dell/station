import { glob, readFile } from "node:fs/promises";
import { relative } from "node:path";

const forbidden = [
  /<(?:code|diff|markdown)(?:\s|>)/i,
  /\b(?:CodeRenderable|MarkdownRenderable)\b/,
  /tree-sitter/i,
];
const violations = [];

for await (const path of glob("station/src/**/*.{ts,tsx}", {
  exclude: (path) => /\.(?:test|spec)\.[^.]+$/.test(path),
})) {
  const source = await readFile(path, "utf8");
  if (forbidden.some((pattern) => pattern.test(source))) violations.push(relative(".", path));
}

if (violations.length > 0) {
  process.stderr.write(
    `Parser-backed production UI is incompatible with the compiled asset exclusions:\n${violations.join("\n")}\n`,
  );
  process.exit(1);
}
