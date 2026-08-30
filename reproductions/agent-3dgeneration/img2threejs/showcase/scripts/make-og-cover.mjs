#!/usr/bin/env node
// Regenerates public/og-cover.png, the social preview card, so the committed PNG is a build
// artifact with a recipe rather than an opaque binary nobody can reproduce.
//
// Two passes, because the hero has to be the real product and not a mock-up: first it loads the
// live workbench, hides every UI layer and shoots the WebGL canvas alone; then it composes that
// render into scripts/og-cover.template.html and shoots the card at 1200x630 @2x.
//
// Playwright is deliberately NOT a devDependency — adding it would make the Pages deploy's
// `npm ci` pull a browser toolchain on every push. Run it through npx instead:
//
//   npx --yes playwright@1.62.1 install chromium   # once
//   npx --yes -p playwright@1.62.1 node scripts/make-og-cover.mjs
//
// Options:
//   --url <origin>   site to shoot the render from (default https://img2threejs.io/)
//   --keep-temp      leave the intermediate render + copied template on disk for inspection

import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

const SITE = arg('--url', 'https://img2threejs.io/');
const KEEP_TEMP = process.argv.includes('--keep-temp');

// Every layer that sits over the canvas. Hidden with visibility, never display: the workbench is a
// flex layout, and display:none collapses the canvas to zero size — Playwright then refuses to
// screenshot it as "not visible".
const CHROME = ['.wb-side', '.wb-rail', '.wb-caption', '.wb-ref', 'header', '.wb-drawer', '.wb-scrim', '.wb-palette'];

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('\nmake-og-cover: playwright not resolvable. See the usage note at the top of this file.\n');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'og-cover-'));
const browser = await chromium.launch();

try {
  /* ------------------------------------------------------- pass 1: the render */
  const shotCtx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2 });
  const site = await shotCtx.newPage();

  await site.goto(SITE, { waitUntil: 'load', timeout: 90_000 });
  await site.waitForSelector('#wb-canvas canvas', { timeout: 60_000 });
  // The intro overlay removes itself when its animation ends; the scene also streams multi-MB
  // geometry chunks, so wait for both rather than guessing one delay.
  await site.waitForFunction(() => !document.querySelector('[class*="intro"]'), null, { timeout: 60_000 });
  await site.waitForTimeout(9000);

  const shown = await site.evaluate(() => {
    const dl = document.querySelector('#wb-specs');
    const specs = {};
    if (dl) {
      const keys = [...dl.querySelectorAll('dt')].map((n) => n.textContent.trim());
      const vals = [...dl.querySelectorAll('dd')].map((n) => n.textContent.trim());
      keys.forEach((k, i) => (specs[k] = vals[i]));
    }
    return { title: document.querySelector('#wb-title')?.textContent?.trim(), specs };
  });

  await site.evaluate((sels) => {
    for (const sel of sels) document.querySelectorAll(sel).forEach((n) => { n.style.visibility = 'hidden'; });
  }, CHROME);
  await site.waitForTimeout(2500);
  await site.screenshot({ path: join(work, 'model.png'), timeout: 60_000 });
  await shotCtx.close();

  console.log(`render: ${shown.title}`);
  console.log(`        ${Object.entries(shown.specs).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log('        the card\'s "SHOWN:" label and index.html\'s og:image:alt both name this');
  console.log('        exhibit and these numbers — update them together if the default changes.');

  /* -------------------------------------------------------- pass 2: the card */
  cpSync(join(ROOT, 'scripts', 'og-cover.template.html'), join(work, 'card.html'));
  cpSync(join(ROOT, 'public', 'favicon.svg'), join(work, 'favicon.svg'));

  const cardCtx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2 });
  const card = await cardCtx.newPage();
  await card.goto(`file://${join(work, 'card.html')}`, { waitUntil: 'load' });
  await card.evaluate(() => document.fonts.ready);
  await card.waitForTimeout(1200);

  mkdirSync(join(ROOT, 'public'), { recursive: true });
  const out = join(ROOT, 'public', 'og-cover.png');
  await card.screenshot({ path: out });
  await cardCtx.close();

  // 1200x630 layout at 2x. index.html declares the real pixel size, so a change here must be
  // mirrored in its og:image:width / og:image:height.
  console.log(`\nwrote ${out} (2400x1260)`);
} finally {
  await browser.close();
  if (KEEP_TEMP) console.log(`temp kept: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
