/**
 * The end-to-end checks of the demo.
 *
 * Every check is a real HTTP request to the running WordPress. A check fails by throwing, with the status and the
 * start of the body in the message, so a failure in CI says what came back, not only that something did.
 * Credentials and keys are never printed.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Session, request } from './http.mjs';
import { sha256Hex, signRequest } from './s2s.mjs';

/** The route that is guarded by alcor_s2s_verify() with the configured key. */
const ORDERS_ROUTE = '/alcor-demo/v1/orders';
/** The REST namespace of AlcorFields. */
const FIELDS = '/alcor-fields/v1';

/**
 * Collapses whitespace and shortens text for error messages.
 * @param {string} text - Response body.
 * @returns {string} At most 160 characters.
 */
const snippet = (text) => text.replace(/\s+/g, ' ').slice(0, 160);

/**
 * Throws when a condition is false.
 * @param {unknown} condition - Value that must be truthy.
 * @param {string} message - Error message.
 */
function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Throws unless a response has the expected status.
 * @param {{ status: number, text: string }} response - The response.
 * @param {number} expected - Expected HTTP status.
 * @param {string} what - What was requested, for the message.
 */
function expectStatus(response, expected, what) {
  expect(
    response.status === expected,
    `${what}: expected HTTP ${expected}, got ${response.status} (${snippet(response.text)})`,
  );
}

/**
 * Decodes the few entities that WordPress's esc_html() produces.
 * @param {string} text - Escaped text.
 * @returns {string} Plain text.
 */
const decodeEntities = (text) =>
  text
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * Finds a Python interpreter on PATH.
 * @returns {string | null} Command name, or null when there is none.
 */
function findPython() {
  for (const command of ['python3', 'python', 'py']) {
    const probe = spawnSync(command, ['--version'], { stdio: 'ignore' });
    if (probe.status === 0) {
      return command;
    }
  }
  return null;
}

/**
 * Runs every check and prints one line per check.
 * @param {object} context - What the checks need.
 * @param {string} context.baseUrl - Server origin.
 * @param {Record<string, string>} context.config - The per-run secrets the seed script also read.
 * @param {Record<string, any>} context.ready - The seed script's receipt.
 * @param {string} context.componentDir - Absolute path of the AlcorWordPress folder.
 * @returns {Promise<Array<{ group: string, name: string, status: 'ok' | 'fail' | 'skip', detail: string }>>}
 *   One entry per check.
 */
export async function runChecks({ baseUrl, config, ready, componentDir }) {
  const results = [];
  let group = '';

  const section = (title) => {
    group = title;
    console.log(`\n${title}`);
  };
  const check = async (name, fn) => {
    try {
      const outcome = await fn();
      if (outcome && typeof outcome === 'object' && outcome.skip) {
        results.push({ group, name, status: 'skip', detail: outcome.skip });
        console.log(`  [skip] ${name}: ${outcome.skip}`);
        return;
      }
      results.push({ group, name, status: 'ok', detail: outcome ?? '' });
      console.log(`  [ok]   ${name}${outcome ? ` -> ${outcome}` : ''}`);
    } catch (error) {
      results.push({ group, name, status: 'fail', detail: error.message });
      console.log(`  [FAIL] ${name}\n         ${error.message}`);
    }
  };

  // Requests with no cookie, like a visitor or a script that has no login.
  const anonymous = (target, options = {}) => request(baseUrl, { path: target, ...options });
  const admin = new Session(baseUrl);
  const client = new Session(baseUrl);
  const versionOf = async (session, key) => {
    const response = await session.rest('GET', `${FIELDS}/documents/${key}`);
    expectStatus(response, 200, `read ${key}`);
    return response.json().version;
  };

  // ------------------------------------------------------------------------------------------------------ site
  section('Site');
  await check('every mu-plugin is loaded, in a fresh WordPress', async () => {
    const onDisk = fs
      .readdirSync(path.join(componentDir, 'mu-plugins'))
      .filter((file) => file.endsWith('.php'))
      .sort();
    const loaded = [...ready.mu_plugins].sort();
    expect(
      JSON.stringify(onDisk) === JSON.stringify(loaded),
      `mu-plugins on disk: ${onDisk.join(', ')}; loaded: ${loaded.join(', ')}`,
    );
    expect(
      ready.environment === 'local',
      `environment type is ${ready.environment}, expected local`,
    );
    expect(
      ready.client_role.includes('alcor_site_editor'),
      'the client editor role was not created',
    );
    return `${loaded.length} mu-plugins, WordPress ${ready.wordpress}, PHP ${ready.php}`;
  });
  await check('sign in as the administrator and as the client editor', async () => {
    await admin.login('demo-admin', config.admin_password);
    await client.login('demo-client', config.client_password);
    return 'cookie + REST nonce for both';
  });

  // ---------------------------------------------------------------------------------------------- AlcorFields
  section('AlcorFields REST: permission callbacks and the document life cycle');
  const landing = `${FIELDS}/documents/demo-landing`;
  await check('anonymous GET /documents is refused', async () => {
    const response = await anonymous('/wp-json/alcor-fields/v1/documents');
    expectStatus(response, 401, 'anonymous list');
    return '401';
  });
  await check(
    'anonymous POST draft is refused, for a real and for an unknown document alike',
    async () => {
      const body = JSON.stringify({ base_version: 0, values: {} });
      const headers = { 'content-type': 'application/json' };
      const real = await anonymous(`/wp-json${landing}/draft`, { method: 'POST', headers, body });
      const unknown = await anonymous(`/wp-json${FIELDS}/documents/no-such-doc/draft`, {
        method: 'POST',
        headers,
        body,
      });
      expectStatus(real, 401, 'anonymous draft of a real document');
      expectStatus(unknown, 401, 'anonymous draft of an unknown document');
      return '401 for both, so document keys cannot be probed';
    },
  );
  await check('a client editor lists only the document assigned to them', async () => {
    const response = await client.rest('GET', `${FIELDS}/documents`);
    expectStatus(response, 200, 'client list');
    const keys = response.json().map((doc) => doc.key);
    expect(JSON.stringify(keys) === '["demo-landing"]', `client sees ${JSON.stringify(keys)}`);
    return 'demo-landing';
  });
  await check(
    'the client is refused a document that is not theirs, and told 404 for an unknown one',
    async () => {
      expectStatus(
        await client.rest('GET', `${FIELDS}/documents/demo-private`),
        403,
        'unassigned document',
      );
      expectStatus(
        await client.rest('GET', `${FIELDS}/documents/no-such-doc`),
        404,
        'unknown document',
      );
      return '403 and 404';
    },
  );
  await check('an administrator lists and opens every document', async () => {
    const response = await admin.rest('GET', `${FIELDS}/documents`);
    expectStatus(response, 200, 'admin list');
    const keys = response.json().map((doc) => doc.key);
    expect(keys.includes('demo-landing') && keys.includes('demo-private'), `admin sees ${keys}`);
    expectStatus(
      await admin.rest('GET', `${FIELDS}/documents/demo-private`),
      200,
      'admin opens private',
    );
    return keys.join(', ');
  });
  await check('the client reads the document: schema, version 0, nothing published', async () => {
    const response = await client.rest('GET', landing);
    expectStatus(response, 200, 'read');
    const doc = response.json();
    const fields = doc.schema.groups.flatMap((g) => g.fields.map((f) => f.key));
    expect(
      doc.version === 0 && doc.published === null && doc.draft === null,
      'document is not pristine',
    );
    expect(fields.includes('hero.title') && fields.includes('menu.items'), `fields: ${fields}`);
    return `${fields.length} top-level fields`;
  });

  let previewUrl = '';
  const draftValues = {
    'hero.title': 'Fresh <em>sourdough</em> daily',
    'hero.lead': 'Fish & <b>Chips</b>',
    'menu.items': [
      { name: 'Seeded rye', price: '5.20' },
      { name: 'Baguette', price: '3.10' },
      { name: 'Focaccia', price: '4.00' },
    ],
  };
  await check('saving a draft bumps the version and leaves the live page alone', async () => {
    const response = await client.rest('POST', `${FIELDS}/documents/demo-landing/draft`, {
      base_version: 0,
      values: draftValues,
      note: 'demo draft',
    });
    expectStatus(response, 200, 'draft');
    const saved = response.json();
    expect(
      saved.version === 1 && saved.state === 'draft',
      `unexpected answer ${JSON.stringify(saved)}`,
    );
    previewUrl = saved.preview_url;
    const live = await anonymous('/alcor-demo/');
    expectStatus(live, 200, 'live page');
    expect(!live.text.includes('sourdough'), 'the draft leaked onto the live page');
    return 'version 1, live page unchanged';
  });
  await check('a stale base_version is a conflict (409), not a silent overwrite', async () => {
    const response = await client.rest('POST', `${FIELDS}/documents/demo-landing/draft`, {
      base_version: 0,
      values: {},
    });
    expectStatus(response, 409, 'stale draft');
    return '409';
  });
  await check(
    'hostile content is refused with every problem (422) and nothing is saved',
    async () => {
      const response = await client.rest('POST', `${FIELDS}/documents/demo-landing/draft`, {
        base_version: 1,
        values: {
          'hero.title': '<script>alert(1)</script>Hi',
          'hero.cta_href': 'javascript:alert(1)',
        },
      });
      expectStatus(response, 422, 'hostile draft');
      const errors = response.json().data.errors;
      const paths = errors.map((error) => error.path);
      expect(
        paths.includes('hero.title') && paths.includes('hero.cta_href'),
        `error paths: ${paths}`,
      );
      expect((await versionOf(client, 'demo-landing')) === 1, 'a refused save changed the version');
      return `${errors.length} problems listed; version still 1`;
    },
  );
  await check('the draft preview link works for the editor only', async () => {
    expect(previewUrl !== '', 'the draft response had no preview_url');
    const url = new URL(previewUrl);
    const target = url.pathname + url.search;
    const visitor = await anonymous(target);
    const editor = await client.send({ path: target });
    expect(!visitor.text.includes('sourdough'), 'an anonymous visitor saw the draft');
    expect(
      editor.text.includes('Fresh <em>sourdough</em> daily'),
      'the editor did not see the draft',
    );
    expect(
      String(editor.headers['x-robots-tag'] ?? '').includes('noindex'),
      'preview is not noindex',
    );
    return 'editor sees the draft, a visitor sees the live page, preview is noindex';
  });
  await check('publishing makes it live, escaped, with no annotations left behind', async () => {
    const response = await client.rest('POST', `${FIELDS}/documents/demo-landing/publish`, {
      base_version: 1,
    });
    expectStatus(response, 200, 'publish');
    expect(response.json().published_version === 2, `published ${JSON.stringify(response.json())}`);
    const live = (await anonymous('/alcor-demo/')).text;
    expect(live.includes('<h1>Fresh <em>sourdough</em> daily</h1>'), 'new heading is not live');
    expect(live.includes('Fish &amp; &lt;b&gt;Chips&lt;/b&gt;'), 'plain text was not escaped');
    expect(
      live.includes('Focaccia') && (live.match(/<li>/g) ?? []).length === 3,
      'list rows are wrong',
    );
    expect(!live.includes('data-af'), 'an annotation leaked into the page');
    return 'published version 2';
  });
  let exported = null;
  await check('export produces a hash-bound hand-off file', async () => {
    const response = await client.rest('GET', `${landing}/export`);
    expectStatus(response, 200, 'export');
    exported = response.json();
    expect(exported.format === 'alcor.fields.document.v1', `format ${exported.format}`);
    expect(/^[0-9a-f]{64}$/.test(exported.content_sha256), 'content_sha256 is not a SHA-256');
    expect(
      exported.values['hero.lead'] === 'Fish & <b>Chips</b>',
      'export does not hold the published text',
    );
    return exported.content_sha256.slice(0, 12);
  });
  await check(
    'importing an edited file is refused: the content hash no longer matches',
    async () => {
      const tampered = structuredClone(exported);
      tampered.values['hero.lead'] = 'Changed after export';
      const response = await client.rest('POST', `${landing}/import`, {
        base_version: await versionOf(client, 'demo-landing'),
        document: tampered,
      });
      expectStatus(response, 422, 'tampered import');
      expect(
        JSON.stringify(response.json()).includes('content_sha256'),
        'error does not name the hash',
      );
      return '422';
    },
  );
  await check(
    'importing the genuine file lands as a draft, and a version can be restored',
    async () => {
      const base = await versionOf(client, 'demo-landing');
      const imported = await client.rest('POST', `${landing}/import`, {
        base_version: base,
        document: exported,
      });
      expectStatus(imported, 200, 'import');
      expect(imported.json().state === 'draft', 'import did not produce a draft');
      const restored = await client.rest('POST', `${landing}/restore`, {
        base_version: imported.json().version,
        version: 2,
      });
      expectStatus(restored, 200, 'restore');
      expect(restored.json().state === 'draft', 'restore did not produce a draft');
      return 'import -> draft, restore v2 -> draft';
    },
  );

  // ------------------------------------------------------------------------------------------------- service
  section('Service-to-service HMAC (alcor-s2s-auth): signature, clock skew, replay, fail closed');
  const body = JSON.stringify({ sku: 'demo-1', qty: 2 });
  const now = () => Math.floor(Date.now() / 1000);
  const post = (headers, { payload = body, target = `/wp-json${ORDERS_ROUTE}` } = {}) =>
    anonymous(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: payload,
    });
  const sign = (overrides = {}) =>
    signRequest({ key: config.s2s_key, method: 'POST', route: ORDERS_ROUTE, body, ...overrides });

  await check('a correctly signed request is accepted', async () => {
    const response = await post(sign());
    expectStatus(response, 200, 'signed request');
    expect(response.json().body_sha256 === sha256Hex(body), 'the server saw a different body');
    return '200';
  });
  await check('replaying the same request is refused (nonce already used)', async () => {
    const headers = sign();
    expectStatus(await post(headers), 200, 'first use');
    expectStatus(await post(headers), 401, 'replay');
    return '200 then 401';
  });
  await check('a stale timestamp is refused even with a valid signature', async () => {
    expectStatus(await post(sign({ timestamp: now() - 600 })), 401, 'stale request');
    return '10 minutes old -> 401';
  });
  await check('a future timestamp is refused too (the window is symmetric)', async () => {
    expectStatus(await post(sign({ timestamp: now() + 600 })), 401, 'future request');
    return '10 minutes ahead -> 401';
  });
  await check('a timestamp inside the 300 s window is accepted', async () => {
    expectStatus(await post(sign({ timestamp: now() - 100 })), 200, 'slightly old request');
    return '100 s old -> 200';
  });
  await check('changing the body after signing is refused', async () => {
    const altered = JSON.stringify({ sku: 'demo-1', qty: 200 });
    expectStatus(await post(sign(), { payload: altered }), 401, 'altered body');
    return '401';
  });
  await check('a signature made with another key is refused', async () => {
    const other = randomBytes(32).toString('hex');
    expectStatus(await post(sign({ key: other })), 401, 'wrong key');
    return '401';
  });
  await check('a request without the headers is refused', async () => {
    expectStatus(await post({}), 401, 'unsigned request');
    return '401';
  });
  await check('the query string is part of the signature', async () => {
    const statusRoute = '/alcor-demo/v1/status';
    const get = (headers, region) =>
      anonymous(`/wp-json${statusRoute}?region=${region}`, { headers });
    const signed = (region) =>
      signRequest({ key: config.s2s_key, method: 'GET', route: statusRoute, query: { region } });
    const good = await get(signed('eu'), 'eu');
    expectStatus(good, 200, 'signed GET');
    expect(good.json().region === 'eu', 'the route did not see the region');
    expectStatus(await get(signed('eu'), 'us'), 401, 'query changed after signing');
    return 'region=eu accepted, region=us with the same signature refused';
  });
  await check('?rest_route= and /wp-json/ forms verify the same way', async () => {
    const response = await post(sign(), { target: `/index.php?rest_route=${ORDERS_ROUTE}` });
    expectStatus(response, 200, 'rest_route form');
    return '200';
  });
  await check('a route whose key is not configured answers 404, like an absent route', async () => {
    const headers = signRequest({
      key: config.s2s_key,
      method: 'POST',
      route: '/alcor-demo/v1/unconfigured',
      body,
    });
    const response = await post(headers, { target: '/wp-json/alcor-demo/v1/unconfigured' });
    expectStatus(response, 404, 'unconfigured route');
    return '404';
  });
  await check('the request built by examples/sign_request.py is accepted', async () => {
    const python = findPython();
    if (python === null) {
      return { skip: 'no Python on PATH' };
    }
    const run = spawnSync(
      python,
      [
        path.join(componentDir, 'examples', 'sign_request.py'),
        '--method',
        'POST',
        '--url',
        `${baseUrl}/wp-json${ORDERS_ROUTE}`,
        '--body',
        body,
        '--key-env',
        'ALCOR_DEMO_ORDERS_KEY',
      ],
      { encoding: 'utf8', env: { ...process.env, ALCOR_DEMO_ORDERS_KEY: config.s2s_key } },
    );
    expect(run.status === 0, `signer exited ${run.status}: ${snippet(run.stderr ?? '')}`);
    expectStatus(await post(JSON.parse(run.stdout)), 200, 'request signed by the Python example');
    return '200';
  });

  // ---------------------------------------------------------------------------------------------- hardening
  section('Hardening: user enumeration, CORS, security.txt, preview hosts');
  await check(
    'anonymous REST user lookups are refused; a signed-in user still gets them',
    async () => {
      expectStatus(await anonymous('/wp-json/wp/v2/users'), 403, 'anonymous users list');
      expectStatus(await anonymous('/wp-json/wp/v2/users/1'), 403, 'anonymous user lookup');
      expectStatus(await admin.rest('GET', '/wp/v2/users'), 200, 'administrator users list');
      return '403, 403, then 200 when signed in';
    },
  );
  await check('?author=1 redirects to the homepage instead of /author/<login>/', async () => {
    const response = await anonymous('/?author=1');
    expectStatus(response, 301, 'author redirect');
    const location = new URL(response.headers.location, baseUrl);
    expect(
      location.pathname === '/' && !location.search,
      `redirected to ${location.pathname}${location.search}`,
    );
    return '301 -> /';
  });
  await check(
    'CORS: a foreign Origin gets no Allow-Origin or Allow-Credentials, the site itself does',
    async () => {
      const foreign = await anonymous('/wp-json/', { headers: { origin: 'https://evil.example' } });
      expectStatus(foreign, 200, 'REST index');
      expect(
        foreign.headers['access-control-allow-origin'] === undefined,
        'foreign origin was allowed',
      );
      expect(
        foreign.headers['access-control-allow-credentials'] === undefined,
        'credentials were allowed',
      );
      const own = await anonymous('/wp-json/', { headers: { origin: baseUrl } });
      expect(
        own.headers['access-control-allow-origin'] === baseUrl,
        'the site origin was not allowed',
      );
      expect(
        own.headers['access-control-allow-credentials'] === 'true',
        'the site origin got no credentials',
      );
      return 'evil.example: none; own origin: allowed';
    },
  );
  await check('security.txt is served (RFC 9116) and /security.txt redirects to it', async () => {
    const file = await anonymous('/.well-known/security.txt');
    expectStatus(file, 200, 'security.txt');
    expect(String(file.headers['content-type']).startsWith('text/plain'), 'not text/plain');
    expect(/^Contact: mailto:security@example\.com$/m.test(file.text), 'Contact line missing');
    expect(/^Expires: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m.test(file.text), 'Expires line missing');
    const legacy = await anonymous('/security.txt');
    expectStatus(legacy, 301, 'legacy location');
    expect(
      String(legacy.headers.location).endsWith('/.well-known/security.txt'),
      'wrong redirect target',
    );
    return 'Contact + Expires present';
  });
  await check('a loopback host is a preview host: noindex header and robots meta', async () => {
    const home = await anonymous('/');
    expect(
      String(home.headers['x-robots-tag'] ?? '').includes('noindex'),
      'no X-Robots-Tag: noindex',
    );
    expect(
      /<meta name='robots' content='[^']*noindex/.test(home.text),
      'no robots meta with noindex',
    );
    return 'X-Robots-Tag and <meta name="robots">';
  });
  await check('a production-looking host gets neither', async () => {
    const home = await anonymous('/', { headers: { host: 'demo.example' } });
    expect(
      home.headers['x-robots-tag'] === undefined,
      `unexpected X-Robots-Tag: ${home.headers['x-robots-tag']}`,
    );
    return 'Host: demo.example -> no X-Robots-Tag';
  });

  // ------------------------------------------------------------------------------------------------------ seo
  section('SEO and structured data: robots.txt, agent catalog, OpenAPI, sitemap, FAQ, IndexNow');
  await check('robots.txt names the AI crawlers and keeps wp-admin closed to them', async () => {
    const robots = await anonymous('/robots.txt');
    expectStatus(robots, 200, 'robots.txt');
    expect(
      /User-agent: GPTBot\nAllow: \/\nDisallow: \/wp-admin\//.test(robots.text),
      'GPTBot group missing',
    );
    expect(robots.text.includes('/agents.json'), 'catalog link missing');
    return 'GPTBot, ClaudeBot, ... groups present';
  });
  await check('/agents.json is a catalog with a placeholder contact', async () => {
    const response = await anonymous('/agents.json');
    expectStatus(response, 200, 'agents.json');
    const catalog = response.json();
    expect(String(response.headers['content-type']).includes('application/json'), 'not JSON');
    expect(
      catalog.schema_version === '1.0' && catalog.services.length > 0,
      'catalog is incomplete',
    );
    expect(catalog.contact.email.endsWith('@example.com'), `contact is ${catalog.contact.email}`);
    expect(catalog.quote_api.url.startsWith(baseUrl), 'quote URL is not on this site');
    return `${catalog.services.length} services`;
  });
  await check('/openapi.json is an OpenAPI 3.1 document, also at /.well-known/', async () => {
    const response = await anonymous('/openapi.json');
    expectStatus(response, 200, 'openapi.json');
    const spec = response.json();
    expect(spec.openapi === '3.1.0', `openapi ${spec.openapi}`);
    expect(spec.servers[0].url === baseUrl, 'servers[0].url is not the site');
    const operation = spec.paths['/wp-json/alcor-agents/v1/quote']?.post;
    expect(operation?.operationId === 'requestQuote', 'the quote operation is missing');
    expect(
      spec.paths['/agents.json'].get.operationId === 'getCatalog',
      'the catalog operation is missing',
    );
    const wellKnown = await anonymous('/.well-known/openapi.json');
    expect(
      wellKnown.text === response.text,
      '/.well-known/openapi.json differs from /openapi.json',
    );
    return Object.keys(spec.paths).join(', ');
  });
  await check('the sitemap lists the code-served route and no longer lists users', async () => {
    const index = await anonymous('/wp-sitemap.xml');
    expectStatus(index, 200, 'sitemap index');
    expect(
      index.text.includes('wp-sitemap-alcorroutes-1.xml'),
      'alcorroutes provider is not listed',
    );
    expect(!index.text.includes('wp-sitemap-users'), 'the users sitemap is still listed');
    const routes = await anonymous('/wp-sitemap-alcorroutes-1.xml');
    expectStatus(routes, 200, 'routes sitemap');
    expect(
      routes.text.includes(`<loc>${baseUrl}/alcor-demo/</loc>`),
      'the demo route is not listed',
    );
    return '/alcor-demo/ listed';
  });
  await check('an unknown or removed sitemap is a 404', async () => {
    expectStatus(await anonymous('/wp-sitemap-users-1.xml'), 404, 'users sitemap');
    return '404';
  });
  await check('FAQPage JSON-LD describes exactly the questions the page shows', async () => {
    const page = await anonymous('/faq/');
    expectStatus(page, 200, 'FAQ page');
    const summaries = [...page.text.matchAll(/<summary>(.*?)<\/summary>/gs)].map((m) =>
      decodeEntities(m[1]),
    );
    const block = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page.text);
    expect(block !== null, 'no JSON-LD block');
    const data = JSON.parse(block[1]);
    const names = data.mainEntity.map((q) => q.name);
    expect(data['@type'] === 'FAQPage', `type ${data['@type']}`);
    expect(
      summaries.length > 0 && JSON.stringify(names) === JSON.stringify(summaries),
      'schema and page differ',
    );
    expect(
      data.mainEntity.every((q) => q.acceptedAnswer?.text),
      'an answer is missing',
    );
    return `${names.length} questions in both`;
  });
  await check('IndexNow serves its key only on a production host, from configuration', async () => {
    const keyPath = `/${config.indexnow_key}.txt`;
    const production = await anonymous(keyPath, { headers: { host: 'demo.example' } });
    expectStatus(production, 200, 'key file on a production host');
    expect(production.text === config.indexnow_key, 'the file does not hold the key');
    const preview = await anonymous(keyPath);
    expect(preview.status !== 200, 'the key was served on a preview host');
    const other = await anonymous('/not-the-key.txt', { headers: { host: 'demo.example' } });
    expect(other.status !== 200, 'an arbitrary .txt file was served');
    return 'key file: production 200, preview and other names not served';
  });

  return results;
}
