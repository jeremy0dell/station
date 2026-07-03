export type ReadStdinOptions = {
  stdin?: AsyncIterable<Buffer | string> & {
    isTTY?: boolean;
  };
  maxBytes?: number;
};

export const defaultStdinMaxBytes = 8 * 1024 * 1024;

export async function readStdinIfAvailable(
  options: ReadStdinOptions = {},
): Promise<string | undefined> {
  const stdin = options.stdin ?? process.stdin;
  if (stdin.isTTY) {
    return undefined;
  }

  const maxBytes = options.maxBytes ?? defaultStdinMaxBytes;
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += buffer.byteLength;
    if (byteCount > maxBytes) {
      throw new Error(`stdin exceeded ${maxBytes} byte limit`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
