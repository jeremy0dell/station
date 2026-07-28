import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const assetRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(assetRoot, "../..");
const d3Entry = fileURLToPath(import.meta.resolve("d3"));
const d3Bundle = resolve(dirname(d3Entry), "../dist/d3.min.js");

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "3000" },
  },
});
const port = Number(values.port);
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`Invalid port: ${values.port}`);
}

const routeDefinitions = [
  ["/", resolve(assetRoot, "observer-architecture.html"), "text/html; charset=utf-8"],
  ["/app.js", resolve(assetRoot, "observer-architecture.js"), "text/javascript; charset=utf-8"],
  ["/styles.css", resolve(assetRoot, "observer-architecture.css"), "text/css; charset=utf-8"],
  ["/d3.js", d3Bundle, "text/javascript; charset=utf-8"],
  [
    "/manifest.json",
    resolve(projectRoot, "docs/generated/observer-architecture-manifest.json"),
    "application/json; charset=utf-8",
  ],
];
const routes = new Map(
  await Promise.all(
    routeDefinitions.map(async ([pathname, path, contentType]) => [
      pathname,
      { body: await readFile(path), contentType },
    ]),
  ),
);

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { ...securityHeaders, Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const [pathname = "/"] = (request.url ?? "/").split("?", 1);
  const route = routes.get(pathname);
  if (route === undefined) {
    response.writeHead(404, securityHeaders);
    response.end("Not found\n");
    return;
  }

  response.writeHead(200, {
    ...securityHeaders,
    "Cache-Control": pathname === "/d3.js" ? "public, max-age=3600" : "no-store",
    "Content-Length": route.body.byteLength,
    "Content-Type": route.contentType,
  });
  response.end(request.method === "HEAD" ? undefined : route.body);
});

await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, values.host, () => {
    server.off("error", rejectListen);
    resolveListen();
  });
});

const address = server.address();
const listeningPort = typeof address === "object" && address !== null ? address.port : port;
const displayHost =
  values.host === "127.0.0.1" || values.host === "::1" ? "localhost" : values.host;
const protocol = "http";
process.stdout.write(
  `Observer architecture visualization: ${protocol}://${displayHost}:${listeningPort}\n`,
);

const stop = () => {
  server.close(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
