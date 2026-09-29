/** PKCE (RFC 7636) helpers. WebCrypto only — same code on Workers and Node 18+. */

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh high-entropy code verifier (43–128 chars, base64url). */
export function generateCodeVerifier(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** S256 challenge for a verifier: base64url(sha256(verifier)). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** Verifier + challenge in one call; keep the verifier, send the challenge. */
export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = generateCodeVerifier();
  return { codeVerifier, codeChallenge: await codeChallenge(codeVerifier) };
}

/** A random `state` (or `nonce`) value. */
export function randomState(byteLength = 16): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
