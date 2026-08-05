const SIGNATURE_HEADER_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;

export const MAX_BODY_BYTES = 256 * 1024;

/** Reads the request body while enforcing a byte-count cap independent of Content-Length. */
export async function readRawBodyWithLimit(request: Request, limit: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) {
    return new Uint8Array(0);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Verifies the Meta `X-Hub-Signature-256: sha256=<hex>` header against the raw request body. */
export async function verifyHmacSignature(
  rawBody: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) {
    return false;
  }

  const match = SIGNATURE_HEADER_PATTERN.exec(signatureHeader);
  if (!match || !match[1]) {
    return false;
  }

  const providedBytes = hexToBytes(match[1].toLowerCase());

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));

  return constantTimeEqual(expectedBytes, providedBytes);
}
