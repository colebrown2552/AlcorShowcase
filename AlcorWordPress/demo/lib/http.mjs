/**
 * Minimal HTTP client for the demo.
 *
 * It uses node:http directly, not fetch, because the checks need things fetch hides: a custom Host header (to
 * pretend to be a production host), an Origin header, redirects left unfollowed, and the raw response headers.
 * `Session` adds a cookie jar and WordPress's REST nonce on top, which is how a logged-in browser talks to REST.
 */
import http from 'node:http';

/**
 * @typedef {object} HttpResponse
 * @property {number} status - HTTP status code.
 * @property {Record<string, string | string[]>} headers - Response headers with lower-case names.
 * @property {string} text - Body decoded as UTF-8.
 * @property {() => any} json - Parses the body as JSON; throws with the body's start when it is not JSON.
 */

/**
 * Sends one HTTP request and never follows redirects.
 * @param {string} baseUrl - Server origin: scheme, host and port of the site under test.
 * @param {object} options - Request options.
 * @param {string} options.path - Path and query, such as /wp-json/.
 * @param {string} [options.method] - HTTP method; defaults to GET.
 * @param {Record<string, string>} [options.headers] - Request headers; a `host` entry overrides the Host header.
 * @param {string | null} [options.body] - Request body, sent as UTF-8.
 * @param {number} [options.timeoutMs] - Give up after this many milliseconds.
 * @returns {Promise<HttpResponse>} The response.
 */
export function request(
  baseUrl,
  { path, method = 'GET', headers = {}, body = null, timeoutMs = 60000 },
) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body === null ? null : Buffer.from(body, 'utf8');
    const outgoing = { ...headers };
    if (payload) {
      outgoing['content-length'] = String(payload.length);
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: outgoing,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json() {
              try {
                return JSON.parse(text);
              } catch {
                throw new Error(`${method} ${path}: body is not JSON: ${text.slice(0, 120)}`);
              }
            },
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`${method} ${path}: no answer in ${timeoutMs} ms`)),
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * A browser-like session: keeps cookies, signs in through wp-login.php and calls REST with the cookie and nonce.
 */
export class Session {
  /**
   * @param {string} baseUrl - Server origin.
   */
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    /** @type {Map<string, string>} */
    this.cookies = new Map();
    this.restNonce = '';
  }

  /**
   * Builds the Cookie header from the jar.
   * @returns {string} Cookie header value, or '' when the jar is empty.
   */
  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /**
   * Stores the cookies a response sets and forgets the ones it expires.
   * @param {HttpResponse} response - A response.
   */
  absorb(response) {
    for (const line of [].concat(response.headers['set-cookie'] ?? [])) {
      const [pair, ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((attribute) => {
        const match = /^\s*(max-age|expires)\s*=\s*(.+)$/i.exec(attribute);
        if (!match) {
          return false;
        }
        return match[1].toLowerCase() === 'max-age'
          ? Number(match[2]) <= 0
          : Date.parse(match[2]) < Date.now();
      });
      if (expired || value === '') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  /**
   * Sends a request with the session's cookies and records the cookies that come back.
   * @param {Parameters<typeof request>[1]} options - Same options as {@link request}.
   * @returns {Promise<HttpResponse>} The response.
   */
  async send(options) {
    const headers = { ...(options.headers ?? {}) };
    const cookie = this.cookieHeader();
    if (cookie) {
      headers.cookie = cookie;
    }
    const response = await request(this.baseUrl, { ...options, headers });
    this.absorb(response);
    return response;
  }

  /**
   * Signs in with the login form, then fetches the REST nonce that WordPress ties to the login.
   * @param {string} username - Login name.
   * @param {string} password - Password.
   * @returns {Promise<void>}
   */
  async login(username, password) {
    // Like a browser, load the form first: WordPress sets its test cookie there and checks it on submit.
    // Playground answers the very first request for the form with a redirect back to the same address (measured
    // with CLI 3.1.50); asking again gets the form, so try up to three times.
    let page = await this.send({ path: '/wp-login.php' });
    for (let attempt = 1; attempt < 3 && page.status === 302; attempt += 1) {
      page = await this.send({ path: '/wp-login.php' });
    }
    if (page.status !== 200) {
      throw new Error(`login form for ${username}: HTTP ${page.status}`);
    }
    const form = new URLSearchParams({
      log: username,
      pwd: password,
      'wp-submit': 'Log In',
      redirect_to: `${this.baseUrl}/wp-admin/`,
      testcookie: '1',
    });
    const response = await this.send({
      method: 'POST',
      path: '/wp-login.php',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const signedIn = [...this.cookies.keys()].some((name) =>
      name.startsWith('wordpress_logged_in_'),
    );
    if (response.status !== 302 || !signedIn) {
      throw new Error(`sign-in as ${username} failed: HTTP ${response.status}`);
    }
    const nonce = await this.send({ path: '/wp-admin/admin-ajax.php?action=rest-nonce' });
    if (nonce.status !== 200 || !/^[0-9a-f]{10}$/.test(nonce.text.trim())) {
      throw new Error(`no REST nonce for ${username}: HTTP ${nonce.status}`);
    }
    this.restNonce = nonce.text.trim();
  }

  /**
   * Calls a REST route as the signed-in user (cookie plus X-WP-Nonce).
   * @param {string} method - HTTP method.
   * @param {string} route - REST route such as /alcor-fields/v1/documents.
   * @param {object} [body] - JSON body.
   * @returns {Promise<HttpResponse>} The response.
   */
  rest(method, route, body = undefined) {
    const headers = { 'x-wp-nonce': this.restNonce };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    return this.send({
      method,
      path: `/wp-json${route}`,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
  }
}
