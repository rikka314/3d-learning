const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

(async () => {
  const stage = process.argv[2] || 'baseline';
  if (!/^[a-z0-9-]+$/.test(stage)) throw new Error('Invalid capture stage');
  const output = path.join(__dirname, 'output', stage);
  if (fs.existsSync(output)) throw new Error('Capture folder exists; use a new stage name');
  fs.mkdirSync(output, { recursive: true });
  const sources = ['src/createHeartModel.ts', 'src/coronaryAnatomy.ts', 'src/heartMaterials.ts', 'src/main.ts', 'src/style.css', 'index.html', 'anatomy-layout.json', 'anatomy-contract.json', 'object-sculpt-spec.json', 'references.json'];
  const snapshot = sources.map(file => {
    const bytes = fs.readFileSync(path.join(__dirname, file));
    fs.writeFileSync(path.join(output, path.basename(file)), bytes);
    return { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto('http://127.0.0.1:4175/?capture=1', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__MODEL_READY__ === true);
    if (await page.evaluate(() => window.__MODEL_ROOT__.name) !== 'heart-multiview-retry') throw new Error('Wrong model served at capture URL');
    const servedSources = [];
    for (const file of ['src/createHeartModel.ts', 'src/coronaryAnatomy.ts', 'src/heartMaterials.ts', 'src/main.ts', 'src/style.css', 'anatomy-layout.json']) {
      const response = await page.request.get(`http://127.0.0.1:4175/${file}?raw`);
      if (!response.ok()) throw new Error(`Missing served source: ${file}`);
      const raw = await response.text();
      const match = raw.match(/^export default ("(?:[^"\\]|\\.)*")/s);
      // Vite may serve the entry module as literal raw text; both forms must hash exactly.
      const bytes = Buffer.from(match ? JSON.parse(match[1]) : raw);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (hash !== snapshot.find(item => item.file === file).sha256) throw new Error(`Served source mismatch: ${file}`);
      servedSources.push({ file, sha256: hash });
    }
    const textureHashes = [];
    for (const file of fs.readdirSync(path.join(__dirname, 'public', 'textures')).filter(file => file.endsWith('.png'))) {
      const response = await page.request.get(`http://127.0.0.1:4175/textures/${file}`);
      if (!response.ok()) throw new Error(`Missing served texture: ${file}`);
      const hash = crypto.createHash('sha256').update(await response.body()).digest('hex');
      const local = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'public', 'textures', file))).digest('hex');
      if (hash !== local) throw new Error(`Served texture mismatch: ${file}`);
      textureHashes.push({ file, sha256: hash });
    }
    const captures = [];
    for (const view of ['front', 'left', 'rear', 'right', 'threeQuarter']) {
      await page.evaluate(name => window.__CAPTURE_VIEW__(name), view);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const file = path.join(output, `${view}.png`);
      await page.screenshot({ path: file });
      captures.push({ view, file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
    }
    await page.evaluate(() => {
      window.__CAPTURE_VIEW__('front');
      window.__MODEL_ROOT__.traverse(object => {
        if (!object.isMesh) return;
        const old = object.material;
        object.userData.captureMaterial = old;
        const plain = (Array.isArray(old) ? old : [old]).map(material => {
          const copy = material.clone();
          if (copy.userData.surfaceProfile) copy.userData.surfaceDetail = 0;
          for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'bumpMap', 'displacementMap']) copy[key] = null;
          copy.needsUpdate = true;
          return copy;
        });
        object.material = Array.isArray(old) ? plain : plain[0];
      });
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(output, 'map-stripped.png') });
    await page.evaluate(() => window.__MODEL_ROOT__.traverse(object => {
      if (!object.isMesh) return;
      for (const mat of Array.isArray(object.material) ? object.material : [object.material]) mat.dispose();
      object.material = object.userData.captureMaterial;
      delete object.userData.captureMaterial;
    }));
    const runtime = await page.evaluate(() => {
      const root = window.__MODEL_ROOT__;
      let invalidVertices = 0;
      const meshes = [];
      root.traverse(object => {
        if (!object.isMesh) return;
        const p = object.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) {
          if (![p.getX(i), p.getY(i), p.getZ(i)].every(Number.isFinite)) invalidVertices++;
        }
      });
      {
          const geometry = root.userData.ventricularEnvelope;
          const p = geometry.attributes.position;
          const vertices = Array.from({ length: p.count }, (_, i) => [p.getX(i), p.getY(i), p.getZ(i)]);
          const n = geometry.attributes.normal;
          const normals = Array.from({ length: n.count }, (_, i) => [n.getX(i), n.getY(i), n.getZ(i)]);
          const index = geometry.index;
          const indices = Array.from({ length: index.count / 3 }, (_, i) => [index.getX(i*3), index.getX(i*3+1), index.getX(i*3+2)]);
          meshes.push({ id: 'ventricular-body-surface', vertices, normals, indices });
      }
      const materialSet = new Set(Object.values(root.userData.sculptRuntime.meshes).map(mesh => mesh.material));
      const materials = [...materialSet].map(material => ({ name: material.name,
        color: material.color?.getHexString(), roughness: material.roughness,
        clearcoat: material.clearcoat, clearcoatRoughness: material.clearcoatRoughness,
        bitmapMaps: ['map','normalMap','roughnessMap','aoMap'].filter(key => material[key]),
        surfaceProfile: material.userData.surfaceProfile ?? null }));
      return { invalidVertices, geometry: { meshes }, materials, performance: window.__RENDER_INFO__(), parts: window.__PART_MANIFEST__() };
    });
    fs.writeFileSync(path.join(output, 'geometry.json'), JSON.stringify(runtime.geometry));
    fs.writeFileSync(path.join(output, 'parts.json'), JSON.stringify(runtime.parts, null, 2));
    fs.writeFileSync(path.join(output, 'parts-for-gate.json'), JSON.stringify({
      model: runtime.parts.rootId,
      parts: runtime.parts.parts.map(part => ({ ...part, name: part.id, label: part.name, kind: 'part', module: part.id })),
    }, null, 2));
    delete runtime.geometry;
    const changed = snapshot.filter(({ file, sha256 }) => crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, file))).digest('hex') !== sha256);
    if (changed.length) throw new Error('Source changed during capture; evidence is invalid');
    const result = { stage, errors, captures, snapshot, servedSources, textureHashes,
      textureHashScope: 'Retained bitmap assets checked for provenance; active material maps are listed in materials.bitmapMaps',
      ...runtime };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
    if (errors.length || runtime.invalidVertices) throw new Error(JSON.stringify({ errors, invalidVertices: runtime.invalidVertices }));
    console.log(JSON.stringify({ stage, performance: runtime.performance, errors, parts: runtime.parts.parts.length }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
