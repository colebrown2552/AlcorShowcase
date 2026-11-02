/**
 * Visual baseline: full-page screenshots of the pages that matter, compared pixel by pixel with an
 * approved baseline.
 *
 * Motion is frozen and moving media (video, canvas, iframes, anything marked data-visual-mask) is
 * masked, so a difference means the page changed, not that something animated. A shot FAILS only
 * when it is broken: a blank page, or more than `--threshold` percent of pixels different. Smaller
 * differences above `--notice` percent are reported as INFO and written to the review pack, so an
 * ordinary content edit does not fail the contract but is still shown to a human.
 *
 *   node browser/visual.mjs <base-url> --compare [--pages /,/menu/] [--widths 1440,768,390]
 *                           [--baseline DIR] [--out DIR] [--threshold 25] [--notice 1]
 *   node browser/visual.mjs <base-url> --approve    (the current screenshots become the baseline)
 *
 * Prints PASS / FAIL / INFO lines like the other contract suites. Exit code 1 means a FAIL, 2
 * means Playwright is unavailable (see playwright.mjs). State lives under SITEKIT_HOME (default
 * ./.sitekit): baseline/, visual/<timestamp>/ and visual/latest-review.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './playwright.mjs';

const argv = process.argv.slice(2);

/**
 * Read the value that follows an option, or a fallback.
 * @param {string} name - the option, e.g. `--pages`.
 * @param {string} fallback - the value when the option is absent.
 * @returns {string} the option's value.
 */
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (argv[index + 1] === undefined) {
    console.error(`visual.mjs: ${name} needs a value`);
    process.exit(2);
  }
  return argv[index + 1];
};

const base = (argv.find((arg) => /^https?:/.test(arg)) || '').replace(/\/$/, '');
if (!base) {
  console.error('usage: visual.mjs <base-url> --compare|--approve [--pages /,/menu/] [options]');
  process.exit(2);
}
const mode = argv.includes('--approve') ? 'approve' : 'compare';
const home = process.env.SITEKIT_HOME || path.join(process.cwd(), '.sitekit');
const baseline = option('--baseline', path.join(home, 'baseline'));
const out = option(
  '--out',
  path.join(home, 'visual', new Date().toISOString().replace(/[:.]/g, '-')),
);
const threshold = Number(option('--threshold', '25')); // percent of pixels that means "broken"
const notice = Number(option('--notice', '1')); // percent of pixels worth an INFO line and a review row
const PAGES = option('--pages', process.env.SITEKIT_VISUAL_PAGES || '/')
  .split(',')
  .filter(Boolean);
const WIDTHS = option('--widths', '1440,768,390').split(',').map(Number);
if (!PAGES.length || WIDTHS.some((width) => !(width > 0))) {
  // Zero checks would end as a pass, so an empty page or width list is a usage error instead.
  console.error('visual.mjs: --pages and --widths must each name at least one valid value');
  process.exit(2);
}
const MASK = 'video, canvas, iframe, [data-visual-mask]';
const FREEZE = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}
html{scroll-behavior:auto!important}`;

let pass = 0;
let fail = 0;
const review = [];

/**
 * Print an informational line that does not change the verdict.
 * @param {string} message - the text after the INFO tag.
 */
const info = (message) => console.log(`INFO ${message}`);

/**
 * Record one check as PASS or FAIL and print it.
 * @param {string} name - what was checked.
 * @param {boolean} ok - whether it held.
 * @param {string} [detail] - why it failed, shown only on FAIL.
 * @returns {boolean} `ok`, so callers can branch on it.
 */
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` - ${detail}`}`);
  return ok;
};

// Launch first: when the browser tools are unavailable nothing should be left behind on disk.
const browser = await launchBrowser();
fs.mkdirSync(out, { recursive: true });
if (mode === 'approve') fs.mkdirSync(baseline, { recursive: true });
const diffPage = await (await browser.newContext()).newPage();

/**
 * Compare two PNG files inside the browser, so no image library is needed.
 * @param {string} referencePath - the approved baseline image.
 * @param {string} currentPath - the screenshot just taken.
 * @returns {Promise<{size?: string, pct?: number, box?: number[]|null, img?: string}>} either a
 *   size mismatch, or the share of differing pixels, their bounding box and a diff image (base64).
 */
async function diff(referencePath, currentPath) {
  const a = fs.readFileSync(referencePath).toString('base64');
  const b = fs.readFileSync(currentPath).toString('base64');
  return diffPage.evaluate(
    async ([first, second]) => {
      const load = (data) =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.src = 'data:image/png;base64,' + data;
        });
      const [ia, ib] = await Promise.all([load(first), load(second)]);
      if (ia.width !== ib.width || ia.height !== ib.height) {
        return { size: `${ib.width}x${ib.height} was ${ia.width}x${ia.height}` };
      }
      const canvas = document.createElement('canvas');
      canvas.width = ia.width;
      canvas.height = ia.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(ia, 0, 0);
      const da = context.getImageData(0, 0, canvas.width, canvas.height);
      context.drawImage(ib, 0, 0);
      const db = context.getImageData(0, 0, canvas.width, canvas.height);
      const p = da.data;
      const q = db.data;
      let changed = 0;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -1;
      let y1 = -1;
      for (let i = 0; i < p.length; i += 4) {
        const delta =
          Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
        if (delta > 48) {
          // Differing pixels turn magenta in the diff image; the rest fades so they stand out.
          changed++;
          q[i] = 255;
          q[i + 1] = 0;
          q[i + 2] = 255;
          const px = (i / 4) % canvas.width;
          const py = Math.floor(i / 4 / canvas.width);
          if (px < x0) x0 = px;
          if (px > x1) x1 = px;
          if (py < y0) y0 = py;
          if (py > y1) y1 = py;
        } else {
          q[i] *= 0.35;
          q[i + 1] *= 0.35;
          q[i + 2] *= 0.35;
        }
      }
      context.putImageData(db, 0, 0);
      return {
        pct: (100 * changed) / (p.length / 4),
        box: changed ? [x0, y0, x1, y1] : null,
        img: canvas.toDataURL('image/png').split(',')[1],
      };
    },
    [a, b],
  );
}

for (const width of WIDTHS) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    isMobile: width < 768,
  });
  for (const route of PAGES) {
    const slug = route === '/' ? 'home' : route.replace(/^\/|\/$/g, '').replace(/\//g, '_');
    const name = `${slug}-${width}`;
    const page = await context.newPage();
    try {
      const response = await page.goto(base + route, { waitUntil: 'load', timeout: 60000 });
      if (!response || response.status() >= 400) {
        check(`${route} @${width} loads`, false, response ? response.status() : 'no response');
        continue;
      }
      const live = await page.evaluate(() => ({
        text: (document.body.innerText || '').trim().length,
        height: document.documentElement.scrollHeight,
      }));
      if (
        !check(
          `${route} @${width} not blank`,
          live.text > 40 && live.height > 300,
          `text ${live.text} chars, height ${live.height}px`,
        )
      )
        continue;
      await page.addStyleTag({ content: FREEZE });
      // Scroll through once so lazy images and reveal-on-scroll content reach their final state.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) {
          window.scrollTo(0, y);
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        window.scrollTo(0, 0);
      });
      await page.evaluate(() => document.fonts && document.fonts.ready);
      await page.waitForTimeout(800);
      const file = path.join(out, `${name}.png`);
      await page.screenshot({
        path: file,
        fullPage: true,
        mask: [page.locator(MASK)],
        maskColor: '#ff00ff',
      });
      if (mode === 'approve') {
        fs.copyFileSync(file, path.join(baseline, `${name}.png`));
        check(`${route} @${width} approved as baseline`, true);
        continue;
      }
      const reference = path.join(baseline, `${name}.png`);
      if (!fs.existsSync(reference)) {
        check(
          `${route} @${width} has a baseline`,
          false,
          'none yet: run with --approve once the page is right',
        );
        continue;
      }
      const d = await diff(reference, file);
      if (d.size) {
        info(
          `${route} @${width} page size changed (${d.size}); pixel compare skipped, content edits are expected`,
        );
        continue;
      }
      if (d.pct > notice) {
        fs.writeFileSync(path.join(out, `${name}-diff.png`), Buffer.from(d.img, 'base64'));
        // One review row per changed shot; `sitekit review` merges these with the other findings.
        review.push({
          path: route,
          width,
          box: d.box,
          body: `Visual change: ${d.pct.toFixed(2)}% of pixels differ from the approved baseline in the box ${d.box.join(',')} (diff: ${name}-diff.png). Approve with \`sitekit visual --approve\` if intended, otherwise fix or revert.`,
        });
        if (d.pct <= threshold)
          info(
            `${route} @${width} ${d.pct.toFixed(2)}% of pixels differ from baseline (see ${name}-diff.png)`,
          );
      }
      check(
        `${route} @${width} is not broken (<= ${threshold}% pixels differ from baseline)`,
        d.pct <= threshold,
        `${d.pct.toFixed(2)}% differ; see ${name}-diff.png`,
      );
    } catch (error) {
      check(`${route} @${width} captured`, false, String(error).slice(0, 160));
    } finally {
      await page.close();
    }
  }
  await context.close();
}
await browser.close();

if (mode === 'approve') {
  const record = { approved: new Date().toISOString(), pages: PAGES, widths: WIDTHS };
  fs.writeFileSync(path.join(baseline, 'APPROVED.json'), JSON.stringify(record, null, 2));
} else {
  const pack = JSON.stringify(
    { source: 'visual', at: new Date().toISOString(), items: review },
    null,
    2,
  );
  fs.writeFileSync(path.join(out, 'review.json'), pack);
  fs.mkdirSync(path.join(home, 'visual'), { recursive: true });
  fs.writeFileSync(path.join(home, 'visual', 'latest-review.json'), pack);
}
// Shown relative to the state folder so the line never carries a machine-specific path.
const shown = path.relative(home, out).split(path.sep).join('/');
console.log(`visual: ${pass} PASS, ${fail} FAIL (shots in ${shown})`);
process.exit(fail ? 1 : 0);
