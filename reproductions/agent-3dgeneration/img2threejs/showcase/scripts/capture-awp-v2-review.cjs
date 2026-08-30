const { chromium } = require('/Users/tamlh/.npm/_npx/420ff84f11983ee5/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const base = 'http://127.0.0.1:5173/img2threejs-showcase/';
const out = process.env.AWP_V2_REVIEW_DIR || path.join(process.cwd(), '.img2threejs', 'v2', 'renders', 'pass-0');
const executablePath = '/Users/tamlh/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
fs.mkdirSync(out, { recursive: true });

async function quiet(page) {
  await page.evaluate(() => {
    document.querySelector('.demo-panel')?.setAttribute('style', 'display:none');
    document.querySelector('.hint')?.setAttribute('style', 'display:none');
  });
}

async function open(page, query = '', freeze = true) {
  const params = [];
  if (freeze) params.push('capture=1');
  if (query) params.push(query.replace(/^&/, ''));
  await page.goto(`${base}?${params.join('&')}#/demo/awp-medusa-v2`, { waitUntil: 'networkidle' });
  await page.waitForSelector('canvas');
  await page.waitForTimeout(900);
  await quiet(page);
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--use-angle=metal'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on('console', (message) => { if (message.type() === 'error') console.error('[browser]', message.text()); });
  await open(page);
  const runtime = await page.evaluate(() => ({ runtime: window.__IMG2THREEJS_RUNTIME__, parts: window.__IMG2THREEJS_PARTS__ }));
  // The model carries a human-readable contact-evidence field, but the capture
  // directory changes every correction loop. Bind the manifest to this pass so
  // later audits never cite stale orbit screenshots from an older loop.
  if (runtime?.runtime?.attachmentGate) {
    runtime.runtime.attachmentGate.renderedContactEvidence = [
      'orbit-left.png',
      'orbit-right.png',
      'orbit-top.png',
    ].map((name) => path.join(out, name)).join(';');
  }
  fs.writeFileSync(path.join(out, 'runtime-manifest.json'), JSON.stringify(runtime, null, 2));
  fs.writeFileSync(path.join(out, 'parts-manifest.json'), JSON.stringify(runtime.parts, null, 2));
  await page.locator('canvas').first().screenshot({ path: path.join(out, 'broadside-front.png') });

  await open(page, '&back=1');
  await page.locator('canvas').first().screenshot({ path: path.join(out, 'broadside-back.png') });

  // Orbit frames are driven through pinCaptureCamera instead of mouse drags. The old path passed
  // `reviewWhite=1` (a V1-only flag that V2 ignores) and dropped `capture=1` so OrbitControls would
  // stay enabled — which meant every orbit frame rendered on the DARK studio background 0x1b1d24.
  // That colour sits next to this weapon's own albedo, so build_foreground_mask found almost no
  // foreground, fell back to `alpha > 16`, and marked the whole opaque frame as the silhouette:
  // every orbit frame measured area=1.0000 and the multi-angle gate passed without testing anything.
  // Driving the camera keeps capture mode (white studio) AND gives real angular separation.
  async function orbit(name, azimuthDeg, elevationDeg) {
    await open(page);
    await page.evaluate(({ az, el }) => {
      const viewer = window.__IMG2THREEJS_VIEWER__;
      const w = window;
      w.__ORBIT_BASE__ = w.__ORBIT_BASE__ || {
        position: viewer.camera.position.toArray(),
        target: viewer.controls.target.toArray(),
        fov: viewer.camera.fov,
        near: viewer.camera.near,
        far: viewer.camera.far,
      };
      const base = w.__ORBIT_BASE__;
      const [tx, ty, tz] = base.target;
      const dx = base.position[0] - tx;
      const dy = base.position[1] - ty;
      const dz = base.position[2] - tz;
      // Pull in for orbit frames: at the broadside framing distance a three-quarter view of this
      // long thin object covers under 3.5% of the frame, which trips build_foreground_mask's
      // `coverage < 0.035` fallback to `alpha > 16` -- on an opaque render that silently reports
      // the WHOLE frame as silhouette (area=1.0000) instead of failing, and the multi-angle gate
      // then reads it as a huge area and passes.
      const radius = Math.hypot(dx, dy, dz) * 0.75;
      const a = (az * Math.PI) / 180;
      const e = (el * Math.PI) / 180;
      viewer.pinCaptureCamera({
        position: [
          tx + radius * Math.cos(e) * Math.sin(a),
          ty + radius * Math.sin(e),
          tz + radius * Math.cos(e) * Math.cos(a),
        ],
        target: [tx, ty, tz],
        fov: base.fov,
        // near/far must follow the orbit radius. Reusing the broadside camera's near plane while
        // moving closer put the whole model IN FRONT of it: the frame came back pure white, coverage
        // read ~0, and the mask fell back to `alpha > 16` -- reporting area=1.0000 for an empty frame.
        near: radius * 0.05,
        far: radius * 6,
      });
    }, { az: azimuthDeg, el: elevationDeg });
    await page.waitForTimeout(250);
    await page.locator('canvas').first().screenshot({ path: path.join(out, `${name}.png`) });
  }

  // Angles chosen so a flat billboard would collapse: two three-quarter views, one from above, and
  // one down the bore where a plane-faked barrel would nearly vanish.
  await orbit('orbit-left', -55, 8);
  await orbit('orbit-right', 55, 14);
  await orbit('orbit-top', 10, 72);
  // 80 deg, not 88: at 88 the down-bore silhouette measured 0.0355 -- within 0.0005 of
  // build_foreground_mask's 0.035 fallback, where the gate would silently go blind again.
  await orbit('orbit-muzzle', 80, 6);
  await browser.close();
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
