/**
 * Request signer for alcor-s2s-auth, the JavaScript twin of examples/sign_request.py.
 *
 * The canonical string and the HMAC must match mu-plugins/alcor-s2s-auth.php byte for byte; the header of that file
 * is the specification. The demo uses this signer to build requests that are correct, stale, replayed or tampered.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * Percent-encodes like PHP's rawurlencode() (RFC 3986): only A-Z a-z 0-9 - _ . ~ stay literal.
 * encodeURIComponent() also leaves ! ' ( ) * alone, which would change the canonical string.
 * @param {string} value - Text to encode.
 * @returns {string} Encoded text.
 */
export function rawurlencode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Hashes text with SHA-256.
 * @param {string} text - Text to hash.
 * @returns {string} Lower-case hex digest.
 */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Builds the string that is signed.
 * @param {object} parts - The request parts.
 * @param {string} parts.method - HTTP method.
 * @param {string} parts.route - REST route as WordPress reports it: no /wp-json prefix, no trailing slash.
 * @param {Record<string, string>} [parts.query] - Query parameters; rest_route is ignored, as on the server.
 * @param {string | number} parts.timestamp - Unix seconds.
 * @param {string} parts.nonce - 32 lower-case hex characters.
 * @param {string} [parts.body] - Raw request body.
 * @returns {string} Seven lines joined with a line feed.
 */
export function canonicalString({ method, route, query = {}, timestamp, nonce, body = '' }) {
  const pairs = Object.keys(query)
    .filter((name) => name !== 'rest_route')
    .sort()
    .map((name) => `${rawurlencode(name)}=${rawurlencode(String(query[name]))}`);
  return [
    'alcor-s2s-v1',
    method.toUpperCase(),
    route,
    pairs.join('&'),
    String(timestamp),
    nonce,
    sha256Hex(body),
  ].join('\n');
}

/**
 * Produces the three authentication headers for a request.
 * @param {object} request - The request to sign.
 * @param {string} request.key - Shared secret.
 * @param {string} request.method - HTTP method.
 * @param {string} request.route - REST route.
 * @param {Record<string, string>} [request.query] - Query parameters.
 * @param {string} [request.body] - Raw request body.
 * @param {number} [request.timestamp] - Unix seconds; defaults to now. Override it to forge a stale request.
 * @param {string} [request.nonce] - Defaults to 16 random bytes as hex.
 * @returns {Record<string, string>} Headers to send with the request.
 */
export function signRequest({
  key,
  method,
  route,
  query = {},
  body = '',
  timestamp = Math.floor(Date.now() / 1000),
  nonce = randomBytes(16).toString('hex'),
}) {
  const canonical = canonicalString({ method, route, query, timestamp, nonce, body });
  return {
    'x-alcor-timestamp': String(timestamp),
    'x-alcor-nonce': nonce,
    'x-alcor-signature': createHmac('sha256', key).update(canonical, 'utf8').digest('hex'),
  };
}
