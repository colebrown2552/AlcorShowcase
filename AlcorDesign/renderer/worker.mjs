/**
 * Chromium rendering adapter for AlcorDesign. Reads one JSON request on stdin and writes one JSON
 * result on stdout. The Rust server spawns it per job; it never attaches to a user browser, and every
 * network destination and output path is checked here before use.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdir, open } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MAX_HTML = 16 * 1024 * 1024;
const MAX_HEIGHT = 24000;
const BLOCKED_PATH =
  /\/(?:wp-admin|wp-login\.php|wp-cron\.php|xmlrpc\.php|logout|log-out|sign-out|checkout|cart)(?:\/|$|\?)/i;
const ASSET_EXTENSION =
  /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|json|xml|txt|md|csv|woff2?|ttf|otf|mp4|webm|mp3|wav|zip|pdf)(?:$|\?)/i;
const CDN_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
]);

// Read only the fixed header; screenshots can be many megabytes.
/**
 * Confirm a PNG file's header matches the expected size, reading only the first bytes.
 * @param {string} file - Path of the PNG.
 * @param {number} width - Expected width in pixels.
 * @param {number} height - Expected height in pixels.
 * @throws {Error} When the header is missing, malformed or differs from the expected size.
 */
export async function validateScreenshotDimensions(file, width, height) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(24);
    let bytesRead = 0;
    while (bytesRead < header.length) {
      const result = await handle.read(header, bytesRead, header.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (
      bytesRead < 24 ||
      header.subarray(1, 4).toString() !== 'PNG' ||
      header.readUInt32BE(16) !== width ||
      header.readUInt32BE(20) !== height
    )
      throw new Error('Chromium screenshot dimensions did not match the captured document.');
  } finally {
    await handle.close();
  }
}

/**
 * Tell whether an IP literal is loopback, private, link-local, multicast or otherwise reserved.
 * @param {string} address - IPv4 or IPv6 literal, optionally in brackets.
 * @returns {boolean} True when the address must not be fetched.
 */
export function privateAddress(address) {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (a.includes(':')) {
    if (a.startsWith('::ffff:')) {
      const tail = a.slice(7);
      if (tail.includes('.')) return privateAddress(tail);
      const parts = tail.split(':').map((part) => Number.parseInt(part, 16));
      if (parts.length === 2)
        return privateAddress(
          `${parts[0] >> 8}.${parts[0] & 255}.${parts[1] >> 8}.${parts[1] & 255}`,
        );
      return true;
    }
    return (
      a === '::' ||
      a === '::1' ||
      a.startsWith('fc') ||
      a.startsWith('fd') ||
      /^fe[89abcdef]/.test(a) ||
      a.startsWith('ff')
    );
  }
  const p = a.split('.').map(Number);
  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    p[0] >= 224 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  );
}

/**
 * Parse a URL and reject anything that is not a plain public-looking HTTP(S) page.
 * @param {string} input - Absolute URL.
 * @returns {URL} The URL with its fragment removed.
 * @throws {Error} For other schemes, embedded credentials, blocked routes or local hosts.
 */
export function parseHttpUrl(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported.');
  if (BLOCKED_PATH.test(url.pathname))
    throw new Error('Authentication, administration and transaction routes are not importable.');
  if (
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    (isIP(url.hostname.replace(/^\[|\]$/g, '')) && privateAddress(url.hostname))
  )
    throw new Error('Local and private network destinations are not importable.');
  url.hash = '';
  return url;
}

async function verifiedUrl(input) {
  const url = parseHttpUrl(input);
  const entries = await lookup(url.hostname, { all: true });
  if (!entries.length || entries.some((entry) => privateAddress(entry.address)))
    throw new Error('The import destination resolves to a private or reserved address.');
  return url;
}

/**
 * Resolve a link against the site root and keep it only if it is an importable same-origin page.
 * @param {string} input - Link as found in a page.
 * @param {string} base - Absolute URL of the site root.
 * @returns {string|null} Normalised page URL, or null to skip the link.
 */
export function pageUrl(input, base) {
  try {
    const root = new URL(base);
    const url = parseHttpUrl(new URL(input, root).href);
    if (url.origin !== root.origin || ASSET_EXTENSION.test(url.pathname)) return null;
    if (
      /\/(?:wp-json|feed)(?:\/|$)/.test(url.pathname) ||
      url.searchParams.has('s') ||
      url.searchParams.has('preview')
    )
      return null;
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Validate a renderer output directory. It must sit inside ALCORDESIGN_DATA_DIR when that is set,
 * otherwise inside the user's local application data directory.
 * @param {string} input - Absolute directory path from the request.
 * @returns {string} The resolved directory.
 * @throws {Error} When the path is relative or outside the permitted data directory.
 */
export function outputDirectory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input))
    throw new Error('output_dir must be an absolute private data directory.');
  const configured = process.env.ALCORDESIGN_DATA_DIR;
  const parent =
    configured && path.isAbsolute(configured)
      ? configured
      : process.env.LOCALAPPDATA ||
        process.env.XDG_DATA_HOME ||
        path.join(os.homedir(), '.local', 'share');
  const relative = path.relative(path.resolve(parent), path.resolve(input));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Renderer artifacts must stay inside the local application data directory.');
  return path.resolve(input);
}

async function browserEngine() {
  const specified = process.env.ALCORDESIGN_PLAYWRIGHT;
  if (specified) {
    const module = await import(pathToFileURL(path.resolve(specified)).href);
    return module.chromium;
  }
  try {
    return (await import('playwright')).chromium;
  } catch {
    throw new Error(
      'Playwright is not installed. Set ALCORDESIGN_PLAYWRIGHT to its index.mjs or install renderer dependencies.',
    );
  }
}

async function createBrowser(request) {
  const chromium = await browserEngine();
  const options = { headless: true, timeout: 15000, args: [] };
  if (process.env.ALCORDESIGN_CHROME) options.executablePath = process.env.ALCORDESIGN_CHROME;
  else if (process.platform === 'win32') options.channel = 'chrome';
  const browser = await chromium.launch(options);
  const context = await browser.newContext({
    viewport: {
      width: clamp(request.width, 320, 2560, 1440),
      height: clamp(request.height, 480, 1600, 1000),
    },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    colorScheme: 'dark',
    serviceWorkers: 'block',
    acceptDownloads: false,
    javaScriptEnabled: request.html === undefined,
  });
  context.on('page', (page) => {
    page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
  });
  return { browser, context };
}

function clamp(value, min, max, fallback) {
  return Math.max(
    min,
    Math.min(max, Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback),
  );
}

async function guardNetwork(context, origin, warnings) {
  const verified = new Map();
  let blocked = 0;
  await context.routeWebSocket('**/*', (socket) => {
    blocked++;
    socket.close();
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    try {
      if (!['GET', 'HEAD'].includes(request.method())) throw new Error('write request');
      const url = parseHttpUrl(request.url());
      const localAsset = url.origin === origin;
      const externalAsset =
        ['image', 'font', 'stylesheet', 'script', 'media'].includes(request.resourceType()) &&
        CDN_HOSTS.has(url.hostname);
      if (!localAsset && !externalAsset) throw new Error('external resource');
      if (!verified.has(url.origin)) verified.set(url.origin, verifiedUrl(url.origin));
      await verified.get(url.origin);
      if (request.isNavigationRequest() && request.frame().parentFrame())
        throw new Error('embedded navigation');
      await route.continue();
    } catch {
      blocked++;
      await route.abort('blockedbyclient').catch(() => {});
    }
  });
  return () => {
    if (blocked)
      warnings.push(
        `${blocked} requests were blocked by the read-only import policy (writes, embedded navigation or external origins).`,
      );
  };
}

async function getText(context, input, origin, limit = 4 * 1024 * 1024, timeout = 7000) {
  let url = parseHttpUrl(input);
  const deadline = Date.now() + timeout;
  if (url.origin !== origin) throw new Error('Discovery only follows the selected site origin.');
  for (let n = 0; n < 4; n++) {
    if (Date.now() >= deadline) throw new Error('Discovery request exceeded its time budget.');
    const response = await context.request.get(url.href, {
      timeout: Math.max(1, deadline - Date.now()),
      maxRedirects: 0,
    });
    if ([301, 302, 303, 307, 308].includes(response.status())) {
      url = parseHttpUrl(new URL(response.headers().location, url).href);
      if (url.origin !== origin) throw new Error('Cross-origin redirect omitted.');
      continue;
    }
    if (Number(response.headers()['content-length']) > limit)
      throw new Error('Discovery response exceeded the size limit.');
    const body = await response.text();
    if (Buffer.byteLength(body) > limit)
      throw new Error('Discovery response exceeded the size limit.');
    return { status: response.status(), body, headers: response.headers() };
  }
  throw new Error('Too many redirects.');
}

async function parseMarkup(page, markup) {
  return page.evaluate((source) => {
    const document = new DOMParser().parseFromString(source, 'text/html');
    return {
      title: document.querySelector('title')?.textContent?.trim() || '',
      links: Array.from(document.querySelectorAll('a[href]'), (link) => link.getAttribute('href')),
    };
  }, markup);
}

async function discover(request, context) {
  const base = await verifiedUrl(request.url);
  const origin = base.origin;
  const maxPages = clamp(request.max_pages, 1, 500, 300);
  const pages = new Map();
  const warnings = [];
  const sitemaps = [];
  const sitemapOnly = request.sitemap_only === true;
  let limitReached = false;
  const add = (input, title = '', source = 'link', sitemap = null) => {
    const url = pageUrl(input, base.href);
    if (!url) return;
    if (pages.has(url)) {
      const entry = pages.get(url);
      if (title && !entry.title) entry.title = title;
      if (!entry.sources.includes(source)) entry.sources.push(source);
      if (sitemap && !entry.sitemap_urls.includes(sitemap)) entry.sitemap_urls.push(sitemap);
      return;
    }
    if (pages.size >= maxPages) {
      limitReached = true;
      return;
    }
    pages.set(url, {
      url,
      title,
      source,
      sources: [source],
      sitemap_urls: sitemap ? [sitemap] : [],
      status: null,
    });
  };
  if (!sitemapOnly) {
    add(base.href, '', 'requested');
    add(origin + '/', '', 'root');
    for (const url of (request.extra_urls || []).slice(0, 500)) add(url, '', 'repository');
  }
  const dom = sitemapOnly ? null : await context.newPage();
  if (!sitemapOnly)
    for (const kind of ['pages', 'posts']) {
      for (let index = 1; index <= 8; index++) {
        try {
          const result = await getText(
            context,
            `${origin}/wp-json/wp/v2/${kind}?per_page=100&page=${index}&_fields=link,title`,
            origin,
          );
          if (result.status !== 200) break;
          const values = JSON.parse(result.body);
          if (!Array.isArray(values)) break;
          for (const value of values)
            if (value.link)
              add(
                value.link,
                String(value.title?.rendered || '').replace(/<[^>]+>/g, ''),
                `wordpress-${kind}`,
              );
          if (values.length < 100 || index >= Number(result.headers['x-wp-totalpages'] || 1)) break;
        } catch {
          break;
        }
      }
    }
  const sitemapQueue = [
    `${origin}/wp-sitemap.xml`,
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
  ];
  const sitemapSeen = new Set();
  const requiredSitemaps = new Set();
  const sitemapDeadline = Date.now() + (sitemapOnly ? 25000 : 90000);
  while (sitemapQueue.length && sitemapSeen.size < 16 && Date.now() < sitemapDeadline) {
    const url = sitemapQueue.shift();
    if (sitemapSeen.has(url)) continue;
    sitemapSeen.add(url);
    try {
      const result = await getText(
        context,
        url,
        origin,
        4 * 1024 * 1024,
        Math.min(7000, sitemapDeadline - Date.now()),
      );
      const valid = /<(?:sitemapindex|urlset)\b/i.test(result.body);
      const receipt = {
        url,
        status: result.status,
        valid_sitemap: valid,
        kind: /<sitemapindex\b/i.test(result.body) ? 'index' : valid ? 'urlset' : null,
        location_count: 0,
        checked_at: new Date().toISOString(),
      };
      sitemaps.push(receipt);
      if (result.status !== 200 || !valid) continue;
      for (const match of result.body.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
        const value = match[1].replace(/&amp;/g, '&').trim();
        receipt.location_count++;
        if (/\.xml(?:\?|$)/i.test(value)) {
          if (new URL(value, origin).origin === origin) {
            const child = new URL(value, origin).href;
            sitemapQueue.push(child);
            requiredSitemaps.add(child);
          }
        } else add(value, '', 'sitemap', url);
      }
    } catch (error) {
      sitemaps.push({
        url,
        status: null,
        valid_sitemap: false,
        error: String(error.message).slice(0, 300),
        checked_at: new Date().toISOString(),
      });
    }
  }
  if (sitemapOnly) {
    const valid = sitemaps.some((s) => s.status === 200 && s.valid_sitemap);
    const childFailed = sitemaps.some(
      (s) => requiredSitemaps.has(s.url) && (s.status !== 200 || !s.valid_sitemap),
    );
    const pending = sitemapQueue.filter((url) => !sitemapSeen.has(url));
    if (!valid)
      warnings.push(
        'No sitemap document could be read. Existing imported pages and captures are preserved.',
      );
    if (childFailed) warnings.push('At least one referenced child sitemap could not be read.');
    if (pending.length)
      warnings.push(`${pending.length} sitemap documents remain unread after the bounded refresh.`);
    if (limitReached) warnings.push(`Sitemap URLs exceeded the ${maxPages}-page limit.`);
    return {
      ok: true,
      url: base.href,
      pages: [...pages.values()],
      sitemaps,
      warnings,
      complete: valid && !childFailed && !pending.length && !limitReached,
      mode: 'sitemap_only',
      discovered_at: new Date().toISOString(),
    };
  }
  const fetched = new Set();
  const started = Date.now();
  while (fetched.size < pages.size && Date.now() - started < 35000) {
    const batch = [...pages.values()].filter((page) => !fetched.has(page.url)).slice(0, 6);
    if (!batch.length) break;
    for (const page of batch) fetched.add(page.url);
    const results = await Promise.all(
      batch.map(async (page) => {
        try {
          const response = await getText(context, page.url, origin);
          page.status = response.status;
          if (
            response.status !== 200 ||
            !/text\/html/i.test(response.headers['content-type'] || '')
          )
            return null;
          return { page, markup: response.body };
        } catch (error) {
          page.error = error.message;
          return null;
        }
      }),
    );
    for (const result of results) {
      if (!result) continue;
      const parsed = await parseMarkup(dom, result.markup);
      if (parsed.title) result.page.title = parsed.title;
      for (const link of parsed.links) {
        try {
          add(new URL(link, result.page.url).href);
        } catch {
          /* Invalid HTML links are omitted. */
        }
      }
    }
  }
  await dom.close();
  const missing = [...pages.values()].filter((page) => page.status === null).length;
  const failed = [...pages.values()].filter(
    (page) => page.status !== null && page.status !== 200,
  ).length;
  if (limitReached)
    warnings.push(`Discovery reached the ${maxPages}-page limit; increase max_pages to continue.`);
  if (missing)
    warnings.push(
      `${missing} discovered pages were not inspected before the discovery time budget expired.`,
    );
  if (failed)
    warnings.push(
      `${failed} routes returned a non-200 response; they remain listed with their status.`,
    );
  return {
    ok: true,
    url: base.href,
    pages: [...pages.values()],
    sitemaps,
    warnings,
    complete: !limitReached && missing === 0,
    discovered_at: new Date().toISOString(),
  };
}

async function capture(request, context) {
  const warnings = [];
  const output = outputDirectory(request.output_dir);
  await mkdir(output, { recursive: true });
  const raw = request.html !== undefined;
  if (raw && (typeof request.html !== 'string' || Buffer.byteLength(request.html) > MAX_HTML))
    throw new Error('HTML must be a string smaller than 16 MiB.');
  const base = raw
    ? parseHttpUrl(request.base_url || request.url || 'https://alcordesign.invalid/')
    : await verifiedUrl(request.url);
  const finishPolicy = await guardNetwork(context, base.origin, warnings);
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on('pageerror', (error) => {
    if (runtimeErrors.length < 4) runtimeErrors.push(error.message.slice(0, 300));
  });
  page.setDefaultTimeout(7000);
  let status = null;
  let commit = null;
  if (raw) {
    // The imported snapshot cannot run its scripts or navigate the renderer.
    const withBase = request.html.replace(/<base\b[^>]*>/gi, '');
    const baseTag = `<base href="${base.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`;
    const markup = /<head\b[^>]*>/i.test(withBase)
      ? withBase.replace(/<head\b[^>]*>/i, (opening) => opening + baseTag)
      : `<!doctype html><html><head>${baseTag}</head><body>${withBase}</body></html>`;
    await page.setContent(markup, { waitUntil: 'domcontentloaded', timeout: 12000 });
  } else {
    const response = await page.goto(base.href, { waitUntil: 'domcontentloaded', timeout: 18000 });
    if (!response) throw new Error('The page did not return an HTTP response.');
    status = response.status();
    if (status < 200 || status >= 300) {
      const address = await response.serverAddr().catch(() => null);
      const responseHeaders = response.headers();
      const diagnostic = {
        server_address: address,
        server: responseHeaders.server || null,
        preview_commit: responseHeaders['x-alcor-preview-commit'] || null,
        body_excerpt: (await response.text().catch(() => '')).slice(0, 200),
      };
      throw new Error(`The page returned HTTP ${status}. ${JSON.stringify(diagnostic)}`);
    }
    if (new URL(page.url()).origin !== base.origin)
      throw new Error('Cross-origin navigation is not importable.');
    commit = response.headers()['x-alcor-preview-commit'] || null;
  }
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  // Scroll once through the document to let lazy images and reveal effects settle.
  const firstHeight = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
  );
  for (let y = 0; y < Math.min(firstHeight, MAX_HEIGHT); y += 1400) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(50);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(180);
  const editResults = await page.evaluate(
    (edits) => {
      const results = [];
      for (const edit of edits) {
        if (typeof edit.selector !== 'string' || edit.selector.length > 500)
          throw new Error('Invalid edit selector.');
        let element;
        try {
          element = document.querySelector(edit.selector);
        } catch {
          throw new Error('Invalid CSS edit selector.');
        }
        if (!element) throw new Error(`Edit selector was not found: ${edit.selector}`);
        if (element.matches('html,head,script,style,meta,link'))
          throw new Error('Only visible content elements can be edited.');
        const action = edit.action || 'edit';
        if (action === 'remove') {
          if (element === document.body) throw new Error('The document body cannot be removed.');
          element.remove();
          results.push({ selector: edit.selector, action, applied: true });
          continue;
        }
        if (action === 'insert') {
          if (!['div', 'p', 'h2'].includes(edit.tag))
            throw new Error('Inserted elements must be div, p or h2.');
          const child = document.createElement(edit.tag);
          element.append(child);
          element = child;
        } else if (action !== 'edit') throw new Error('Unknown edit action.');
        if ('text' in edit) element.textContent = String(edit.text).slice(0, 20000);
        for (const [key, value] of Object.entries(edit.styles || {})) {
          if (
            !/^(?:color|background|background-color|font-family|font-size|font-weight|line-height|letter-spacing|text-align|text-decoration|border|border-radius|border-color|border-width|border-style|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?|width|height|min-width|max-width|min-height|max-height|display|opacity|visibility|overflow|gap|row-gap|column-gap|align-items|align-content|align-self|justify-content|justify-items|justify-self|flex-direction|flex-wrap|flex-grow|flex-shrink|flex-basis|order|grid-template-columns|grid-template-rows|grid-auto-flow|grid-column|grid-row|position|left|top|right|bottom|transform|translate|z-index|box-shadow)$/.test(
              key,
            )
          )
            throw new Error(`Unsupported style property: ${key}`);
          if (
            typeof value !== 'string' ||
            value.length > 500 ||
            /url\s*\(|image-set\s*\(|expression\s*\(|@import|javascript:/i.test(value)
          )
            throw new Error('Unsupported CSS value.');
          if (value && !CSS.supports(key, value)) throw new Error(`Invalid CSS value for ${key}.`);
          element.style.setProperty(key, value, 'important');
        }
        results.push({ selector: edit.selector, action, applied: true });
      }
      return results;
    },
    Array.isArray(request.edits) ? request.edits.slice(0, 100) : [],
  );
  await page.waitForTimeout(100);
  // Keep form geometry while preventing imported credentials and typed content
  // from surviving in either the initial pixels or the reusable HTML snapshot.
  await page.evaluate(() => {
    for (const input of document.querySelectorAll('input')) {
      if (
        !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color'].includes(input.type)
      ) {
        input.value = '';
        input.removeAttribute('value');
      }
    }
    for (const textarea of document.querySelectorAll('textarea')) {
      textarea.value = '';
      textarea.textContent = '';
    }
  });
  const scene = await page.evaluate(
    ({ maxNodes, maxHeight, baseUrl }) => {
      const omitted = new Set([
        'script',
        'style',
        'link',
        'meta',
        'head',
        'title',
        'base',
        'noscript',
        'template',
      ]);
      const elements = Array.from(document.body?.querySelectorAll('*') || []);
      const nodes = [];
      let skipped = 0;
      let serial = 0;
      const usedIds = new Set();
      for (const element of elements) {
        let id = element.getAttribute('data-alcor-design-id');
        if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || usedIds.has(id)) {
          do {
            id = `ad-${++serial}`;
          } while (usedIds.has(id) || document.querySelector(`[data-alcor-design-id="${id}"]`));
          element.setAttribute('data-alcor-design-id', id);
        }
        usedIds.add(id);
      }
      const styleKeys = [
        'color',
        'background-color',
        'font-family',
        'font-size',
        'font-weight',
        'line-height',
        'letter-spacing',
        'text-align',
        'border-radius',
        'border-color',
        'border-width',
        'border-style',
        'padding',
        'margin',
        'display',
        'position',
        'opacity',
        'gap',
        'align-items',
        'justify-content',
        'flex-direction',
        'flex-wrap',
        'flex-grow',
        'flex-shrink',
        'flex-basis',
        'order',
        'align-content',
        'align-self',
        'justify-items',
        'justify-self',
        'row-gap',
        'column-gap',
        'grid-template-columns',
        'grid-template-rows',
        'grid-auto-flow',
        'grid-column',
        'grid-row',
        'box-shadow',
      ];
      for (const element of elements) {
        const tag = element.tagName.toLowerCase();
        if (omitted.has(tag)) continue;
        const rect = element.getBoundingClientRect();
        const css = getComputedStyle(element);
        if (
          rect.width < 1 ||
          rect.height < 1 ||
          css.display === 'none' ||
          css.visibility === 'hidden' ||
          rect.top > maxHeight
        )
          continue;
        if (nodes.length >= maxNodes) {
          skipped++;
          continue;
        }
        const id = element.getAttribute('data-alcor-design-id');
        const parent = element.parentElement?.closest('[data-alcor-design-id]');
        const directText = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        const name =
          element.getAttribute('aria-label') ||
          element.getAttribute('alt') ||
          element.getAttribute('id') ||
          directText.slice(0, 80) ||
          `${tag}${element.classList?.length ? '.' + Array.from(element.classList).slice(0, 2).join('.') : ''}`;
        const styles = Object.fromEntries(styleKeys.map((key) => [key, css.getPropertyValue(key)]));
        const attrs = {};
        for (const key of ['id', 'class', 'role', 'aria-label', 'alt', 'href', 'src', 'type'])
          if (element.hasAttribute(key)) attrs[key] = element.getAttribute(key);
        nodes.push({
          id,
          parent_id: parent?.getAttribute('data-alcor-design-id') || null,
          selector: `[data-alcor-design-id="${id}"]`,
          tag,
          name,
          text: directText.slice(0, 4000),
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          styles,
          inline_style: element.getAttribute('style') || '',
          attributes: attrs,
        });
      }
      const clone = document.documentElement.cloneNode(true);
      for (const node of clone.querySelectorAll(
        'script,iframe,object,embed,base,meta[http-equiv],link[rel="preload"],link[rel="prefetch"],link[rel="modulepreload"]',
      ))
        node.remove();
      for (const element of clone.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
          if (
            /^on/i.test(attribute.name) ||
            ['nonce', 'integrity', 'srcdoc', 'autofocus'].includes(attribute.name)
          )
            element.removeAttribute(attribute.name);
        }
        if (element.matches('form')) {
          element.removeAttribute('action');
          element.removeAttribute('method');
        }
        if (
          element.matches('input') &&
          !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color'].includes(
            element.type,
          )
        ) {
          element.value = '';
          element.removeAttribute('value');
        }
        if (element.matches('textarea')) {
          element.value = '';
          element.textContent = '';
        }
        if (element.matches('input[type="hidden"]')) element.remove();
        for (const name of ['href', 'src', 'poster']) {
          const value = element.getAttribute(name);
          if (!value || value.startsWith('#') || value.startsWith('data:image/')) continue;
          try {
            const url = new URL(value, baseUrl);
            if (['http:', 'https:'].includes(url.protocol)) element.setAttribute(name, url.href);
            else element.removeAttribute(name);
          } catch {
            element.removeAttribute(name);
          }
        }
      }
      let canvasSnapshots = 0;
      for (const original of document.querySelectorAll('canvas[data-alcor-design-id]')) {
        try {
          const target = clone.querySelector(
            `[data-alcor-design-id="${original.getAttribute('data-alcor-design-id')}"]`,
          );
          if (!target) continue;
          const image = document.createElement('img');
          for (const attr of target.attributes) image.setAttribute(attr.name, attr.value);
          const computed = getComputedStyle(original);
          for (const key of [
            'position',
            'inset',
            'top',
            'left',
            'right',
            'bottom',
            'width',
            'height',
            'z-index',
            'opacity',
            'display',
            'pointer-events',
            'transform',
            'object-fit',
          ])
            image.style.setProperty(key, computed.getPropertyValue(key));
          image.src = original.toDataURL('image/png');
          image.alt = 'Captured canvas';
          target.replaceWith(image);
          canvasSnapshots++;
        } catch {
          /* Cross-origin canvas content stays represented by the page screenshot. */
        }
      }
      const head = clone.querySelector('head') || clone;
      const base = document.createElement('base');
      base.href = baseUrl;
      head.prepend(base);
      const freeze = document.createElement('style');
      freeze.textContent =
        '*,*::before,*::after{animation-play-state:paused!important;transition:none!important}html{scroll-behavior:auto!important}';
      head.append(freeze);
      return {
        title: document.title || 'Untitled page',
        nodes,
        html: '<!doctype html>\n' + clone.outerHTML,
        document_height: Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight || 0,
        ),
        links: Array.from(document.querySelectorAll('a[href]'), (a) => a.href),
        skipped,
        canvasSnapshots,
      };
    },
    {
      maxNodes: clamp(request.max_nodes, 50, 5000, 2000),
      maxHeight: MAX_HEIGHT,
      baseUrl: base.href,
    },
  );
  const screenshot = path.join(output, `render-${randomUUID()}.png`);
  const width = page.viewportSize().width;
  const height = Math.min(MAX_HEIGHT, Math.max(page.viewportSize().height, scene.document_height));
  await page.screenshot({
    path: screenshot,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    clip: { x: 0, y: 0, width, height },
    timeout: 12000,
  });
  await validateScreenshotDimensions(screenshot, width, height);
  finishPolicy();
  if (scene.document_height > MAX_HEIGHT)
    warnings.push(
      `The page is ${scene.document_height}px tall; the preview includes the first ${MAX_HEIGHT}px.`,
    );
  if (scene.skipped)
    warnings.push(`${scene.skipped} visible elements were omitted by the layer limit.`);
  if (runtimeErrors.length) warnings.push(`Page scripts reported: ${runtimeErrors.join(' | ')}`);
  if (Buffer.byteLength(scene.html) > MAX_HTML)
    throw new Error('The rendered HTML snapshot exceeded 16 MiB.');
  return {
    ok: true,
    url: raw ? base.href : page.url(),
    title: scene.title,
    width,
    height,
    document_height: scene.document_height,
    screenshot,
    html: scene.html,
    nodes: scene.nodes,
    links: [...new Set(scene.links.map((url) => pageUrl(url, base.href)).filter(Boolean))],
    commit,
    status,
    edits: editResults,
    canvas_snapshots: scene.canvasSnapshots,
    warnings,
    captured_at: new Date().toISOString(),
    renderer: `Chromium ${context.browser().version()}`,
  };
}

/**
 * Run one render request and return the result object.
 * @param {object} request - Request with a mode (discover or capture) and its options.
 * @returns {Promise<object>} The mode's result, as described in README.md.
 */
export async function runWorker(request) {
  if (!request || typeof request !== 'object' || !['capture', 'discover'].includes(request.mode))
    throw new Error('mode must be capture or discover.');
  const { browser, context } = await createBrowser(request);
  try {
    return await (request.mode === 'discover'
      ? discover(request, context)
      : capture(request, context));
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_HTML + 1024 * 1024)
        throw new Error('Renderer request exceeds the 17 MiB limit.');
    }
    const result = await runWorker(JSON.parse(input));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 1500) }) + '\n',
    );
    process.exitCode = 1;
  }
}
