import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5176/img2threejs-showcase/';
const outDir = process.argv[3] ?? 'pipelines/warrior/evidence/animation-continuity-renders';
const profile = JSON.parse(fs.readFileSync('pipelines/warrior/render-profile.json', 'utf8'));
const defaultActions = [
  'tripo-motion-1', 'tripo-motion-4', 'staff-attack',
];
const actions = process.argv[4]?.split(',').filter(Boolean) ?? defaultActions;
const angles = [0, 40, 90];
const measuredFrameSeconds = 1 / 24;
const coverageDiagnostic = process.env.WARRIOR_COVERAGE_DIAGNOSTIC === '1';
const pageUrl = new URL(baseUrl);
pageUrl.searchParams.set('bg', '0f0f0f');
pageUrl.searchParams.set('capture', '1');
pageUrl.hash = '#/demo/warrior';

fs.mkdirSync(outDir, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'warrior-animation-review-'));
const chrome = spawn(chromePath, [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  `--user-data-dir=${profileDir}`,
  '--window-size=931,1200',
  pageUrl.toString(),
], { stdio: ['ignore', 'ignore', 'pipe'] });

try {
  const port = await readDevToolsPort(chrome);
  const target = await waitForPageTarget(port);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  try {
    const requestUrls = [];
    cdp.on('Network.requestWillBeSent', (params) => requestUrls.push(params.request.url));
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 931,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });
    if (process.env.WARRIOR_DISABLE_DQS === '1') {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'globalThis.__WARRIOR_DISABLE_DQS__ = true;' });
      await cdp.send('Page.reload');
    }
    await waitForExpression(cdp, 'window.__IMG2THREEJS_READY__ === true', 120_000);
    await waitForExpression(cdp, `(() => {
      let model;
      window.__IMG2THREEJS_VIEWER__?.scene?.traverse((candidate) => {
        if (!model && candidate.userData?.sculptRuntime?.animationController) model = candidate;
      });
      return model?.userData?.sculptRuntime?.pass === 'stage-3-embedded-surface-set';
    })()`, 120_000);
    await cdp.evaluate(`(() => {
      document.querySelector('.demo-panel')?.setAttribute('style', 'display:none');
      document.querySelector('.hint')?.setAttribute('style', 'display:none');
    })()`);
    if (coverageDiagnostic) {
      await cdp.evaluate(`(() => {
        const colours = { 45: 0xff2f8f, 46: 0xffd928, 64: 0x16d9ff, 84: 0x32ff68 };
        window.__IMG2THREEJS_VIEWER__.scene.traverse((candidate) => {
          const node = Number(candidate.userData?.moduleNode);
          if (!(node in colours) || !candidate.material) return;
          const source = Array.isArray(candidate.material) ? candidate.material : [candidate.material];
          const cloned = source.map((material) => {
            const next = material.clone();
            next.color?.setHex(colours[node]);
            if (next.emissive) next.emissive.setHex(colours[node]);
            next.emissiveIntensity = 0.18;
            next.needsUpdate = true;
            return next;
          });
          candidate.material = Array.isArray(candidate.material) ? cloned : cloned[0];
        });
      })()`);
    }

    const captures = [];
    for (const action of actions) {
      const moments = action === 'staff-attack'
        ? [
          { id: 'entry', seconds: measuredFrameSeconds },
          { id: 'prepared', seconds: 0.18 },
          { id: 'impact', seconds: 0.5 },
          { id: 'recovery', seconds: 0.92 },
        ]
        : action === 'tripo-motion-4'
          ? [
            { id: 'fade-entry', seconds: measuredFrameSeconds },
            { id: 'fade-mid', seconds: 0.1875 },
            { id: 'fully-hidden', seconds: 0.375 },
            { id: 'motion-started', seconds: 0.575 },
            // Runtime verification worst times plus the measured 0.375 s
            // hide prelude; keep these tied to the machine-readable report.
            { id: 'leg-cross-audit', seconds: 11.395833333333332 },
            { id: 'cloth-clearance-audit', seconds: 6.53125 },
            // Worst measured leg-layer edge distortion, from
            // tripo-motion-4-leg-layer-stretch.json.
            { id: 'node-84-worst-stretch', seconds: 4.916666666666667 },
            { id: 'node-64-worst-stretch', seconds: 5.416666666666667 },
            // Worst measured garment-coverage margins, from the leg-layer
            // coverage report for this action.
            { id: 'coverage-high-x-audit', seconds: 8.5 },
            { id: 'coverage-front-z-audit', seconds: 9.833333333333334 },
            { id: 'coverage-fold-audit', seconds: 10.041666666666666 },
            { id: 'coverage-low-x-audit', seconds: 10.541666666666666 },
          ]
        : action === 'tripo-motion-1'
          ? [
            { id: 'staff-direction-audit', seconds: 0.3333333333333333 },
            { id: 'right-front-envelope-audit', seconds: 1.625 },
            { id: 'left-front-envelope-audit', seconds: 2.625 },
            { id: 'lateral-envelope-audit', seconds: 3.5416666666666665 },
            { id: 'late-envelope-audit', seconds: 4.583333333333333 },
          ]
        : [{ id: 'midpoint', seconds: null }];
      for (const moment of moments) {
        const pose = await cdp.evaluate(`(() => {
          const viewer = window.__IMG2THREEJS_VIEWER__;
          let model;
          viewer.scene.traverse((candidate) => {
            if (!model && candidate.userData?.sculptRuntime?.animationController) model = candidate;
          });
          if (!model) throw new Error('warrior model runtime was not found');
          const controller = model.userData.sculptRuntime.animationController;
          const clip = model.animations.find((candidate) => candidate.name === ${JSON.stringify(action)});
          if (!clip) throw new Error('animation clip was not found');
          controller.stop();
          controller.play(${JSON.stringify(action)});
          const frameSeconds = ${measuredFrameSeconds};
          const requestedSeconds = ${moment.seconds === null ? 'clip.duration * 0.5' : moment.seconds};
          const captureSeconds = Math.min(clip.duration, requestedSeconds);
          let elapsed = 0;
          while (elapsed + frameSeconds < captureSeconds) {
            controller.update(frameSeconds);
            elapsed += frameSeconds;
          }
          controller.update(captureSeconds - elapsed);
          viewer.scene.updateMatrixWorld(true);
          const hiddenParts = {};
          model.traverse((candidate) => {
            const node = Number(candidate.userData?.moduleNode);
            if (node !== 54 && node !== 59) return;
            const materials = Array.isArray(candidate.material) ? candidate.material : [candidate.material];
            hiddenParts[node] = {
              visible: candidate.visible,
              opacity: materials[0]?.opacity,
            };
          });
          return { durationSeconds: clip.duration, captureSeconds, hiddenParts };
        })()`);

        for (const angle of angles) {
        await cdp.evaluate(`(() => {
          const viewer = window.__IMG2THREEJS_VIEWER__;
          const cameraProfile = ${JSON.stringify(profile.camera)};
          const azimuth = ${angle};
          const { camera, controls } = viewer;
          const target = cameraProfile.target;
          const radius = Math.hypot(
            cameraProfile.position[0] - target[0],
            cameraProfile.position[2] - target[2],
          );
          const theta = azimuth * Math.PI / 180;
          camera.fov = cameraProfile.fovDegrees;
          camera.position.set(
            target[0] + Math.sin(theta) * radius,
            target[1],
            target[2] + Math.cos(theta) * radius,
          );
          camera.lookAt(target[0], target[1], target[2]);
          camera.updateProjectionMatrix();
          camera.updateMatrixWorld(true);
          if (controls) {
            controls.enabled = false;
            controls.target.set(...target);
            controls.update();
          }
          viewer.renderer.render(viewer.scene, camera);
        })()`);
        const result = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
        });
          const momentSuffix = moment.id === 'midpoint' ? '' : `-${moment.id}`;
          const file = path.join(outDir, `${action}${momentSuffix}-${angle}.png`);
          fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
          captures.push({ action, moment: moment.id, angle, file, ...pose, bytes: fs.statSync(file).size });
        }
      }
    }
    const forbiddenRequests = requestUrls.filter((requestUrl) => /\.(?:glb|bin)(?:[?#]|$)/i.test(requestUrl));
    const networkAudit = {
      requestCount: requestUrls.length,
      forbiddenExtensions: ['.glb', '.bin'],
      forbiddenRequests,
      passed: forbiddenRequests.length === 0,
    };
    console.log(JSON.stringify({ baseUrl, measuredFrameSeconds, captures, networkAudit }, null, 2));
    if (forbiddenRequests.length) throw new Error(`runtime requested forbidden binary assets: ${forbiddenRequests.join(', ')}`);
  } finally {
    cdp.close();
  }
} finally {
  if (chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill('SIGTERM');
    await Promise.race([exited, wait(2_000)]);
  }
  // Chrome may still be flushing its profile for a few milliseconds after
  // exit notification. Cleanup failure must not hide the actual QA result.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
      break;
    } catch {
      await wait(100);
    }
  }
}

async function readDevToolsPort(process) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome DevTools endpoint did not start')), 30_000);
    process.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited before DevTools started (${code})`));
    });
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (chunk) => {
      const match = chunk.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
  });
}

async function waitForPageTarget(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((candidate) => candidate.type === 'page');
      if (target?.webSocketDebuggerUrl) return target;
    } catch { /* Chrome is still starting. */ }
    await wait(100);
  }
  throw new Error('Chrome page target was not available');
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      listeners.get(message.method)?.forEach((listener) => listener(message.params));
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      }
      return result.result.value;
    },
    close() { socket.close(); },
    on(method, listener) {
      const methodListeners = listeners.get(method) ?? new Set();
      methodListeners.add(listener);
      listeners.set(method, methodListeners);
      return () => methodListeners.delete(listener);
    },
  };
}

async function waitForExpression(cdp, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return;
    await wait(100);
  }
  throw new Error(`timed out waiting for ${expression}`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
