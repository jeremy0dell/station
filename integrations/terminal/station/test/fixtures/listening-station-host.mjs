import { createServer } from "node:net";

const socketFlag = process.argv.indexOf("--socket");
const socketPath = socketFlag < 0 ? undefined : process.argv[socketFlag + 1];
if (socketPath === undefined || socketPath.length === 0) {
  process.exitCode = 2;
} else {
  const server = createServer((socket) => socket.end());
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  server.listen(socketPath);
}
