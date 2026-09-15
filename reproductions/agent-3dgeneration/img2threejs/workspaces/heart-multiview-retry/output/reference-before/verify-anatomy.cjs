const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let reportPath;

(async () => {
  const stage = process.argv[2];
  if (!stage || !/^[a-z0-9-]+$/.test(stage)) throw new Error('Pass a captured evidence stage');
  const output = path.join(__dirname, 'output', stage);
  reportPath = path.join(output, 'anatomy-check.json');
  const captureBytes = fs.readFileSync(path.join(output, 'report.json'));
  const capture = JSON.parse(captureBytes);
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const checkSnapshot = () => {
    for (const item of capture.snapshot) {
      if (hash(fs.readFileSync(path.join(__dirname, item.file))) !== item.sha256) throw new Error(`Stale capture: ${item.file}`);
    }
  };
  fs.writeFileSync(path.join(output, 'anatomy-check.json'), JSON.stringify({ passed: false, status: 'running' }));
  if (capture.errors.length || capture.invalidVertices !== 0) throw new Error('Capture contains runtime errors or invalid vertices');
  for (const view of ['front','left','rear','right','threeQuarter']) {
    const images = capture.captures.filter(image => image.view === view);
    if (images.length !== 1 || hash(fs.readFileSync(path.join(output, `${view}.png`))) !== images[0].sha256) throw new Error(`Missing or altered captured view: ${view}`);
  }
  checkSnapshot();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4175/?capture=1', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__MODEL_READY__ === true);
    for (const item of capture.servedSources) {
      const response = await page.request.get(`http://127.0.0.1:4175/${item.file}?raw`);
      const raw = await response.text();
      const match = raw.match(/^export default ("(?:[^"\\]|\\.)*")/s);
      if (!response.ok() || hash(Buffer.from(match ? JSON.parse(match[1]) : raw)) !== item.sha256) throw new Error(`Served source mismatch: ${item.file}`);
    }
    const result = await page.evaluate(async () => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const root = window.__MODEL_ROOT__;
      root.updateMatrixWorld(true);
      const { nodes, meshes } = root.userData.sculptRuntime;
      const checks = [];
      const add = (id, passed, evidence) => checks.push({ id, passed: !!passed, evidence });
      const paths = {};
      const local = p => root.worldToLocal(p.clone());
      for (const [id, node] of Object.entries(nodes)) {
        const wall = meshes[`${id}-wall`];
        const curve = wall?.geometry.parameters?.path;
        if (!curve) continue;
        paths[id] = Array.from({ length: 401 }, (_, i) => local(wall.localToWorld(curve.getPointAt(i / 400))).toArray());
      }
      const v = p => new THREE.Vector3().fromArray(p);
      const first = id => v(paths[id][0]);
      const last = id => v(paths[id].at(-1));
      const distanceTo = (p, id) => Math.min(...paths[id].map(q => p.distanceTo(v(q))));
      function inMesh(point, mesh) {
        const copy = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        copy.matrixAutoUpdate = false;
        copy.matrixWorld.copy(mesh.matrixWorld);
        const world = root.localToWorld(point.clone());
        const votes = [[1,.173,.391],[-.217,1,.413],[.311,.197,1]].map(direction => {
          const ray = new THREE.Raycaster(world, v(direction).normalize());
          const hits = ray.intersectObject(copy, false);
          const distinct = hits.filter((h, i) => !i || Math.abs(h.distance - hits[i-1].distance) > 1e-5);
          return distinct.length % 2 === 1;
        });
        copy.material.dispose();
        return votes.filter(Boolean).length >= 2;
      }
      const chamber = (id, point) => inMesh(point, meshes[`${id}-surface`]);
      add('four-external-chamber-regions', ['left-atrium','right-atrium','left-ventricle','right-ventricle'].every(id => meshes[`${id}-surface`]), 'Four selectable exterior regions; no internal cavities inferred.');
      for (const side of ['left','right']) {
        const id = `${side}-auricle`, host = `${side}-atrium`;
        const surface = meshes[`${id}-surface`];
        const p = surface.geometry.attributes.position;
        let embedded = 0, samples = 0;
        for (let i = 0; i < p.count; i += 11) {
          const point = local(surface.localToWorld(new THREE.Vector3().fromBufferAttribute(p, i)));
          if (chamber(host, point)) embedded++;
          samples++;
        }
        const embeddedFraction = embedded / samples;
        add(`${id}-attachment`, nodes[id].parent === nodes[host] && embeddedFraction > .08 && embeddedFraction < .95, { parent: nodes[id].parent.name, embeddedFraction, samples, method: 'Sampled appendage surface penetrates its atrial base and also extends outside it.' });
      }
      for (const id of ['superior-vena-cava','inferior-vena-cava']) {
        add(`${id}-right-atrium`, chamber('right-atrium', first(id)) && !chamber('left-atrium', first(id)), { root: first(id).toArray() });
      }
      const pv = Object.keys(paths).filter(id => id.includes('pulmonary-vein'));
      add('four-pulmonary-veins', pv.length === 4 && pv.every(id => chamber('left-atrium', first(id)) && !chamber('right-atrium', first(id)) && first(id).z < 0), pv);
      for (const [side, sign] of [['left',1],['right',-1]]) {
        const id = `${side}-pulmonary-branch`;
        const gap = first(id).distanceTo(last('pulmonary-trunk'));
        add(`${id}-bifurcation`, gap < 1e-5 && last(id).x * sign > 0.8, { centerlineGap: gap, distal: last(id).toArray() });
      }
      const aorticBranches = ['brachiocephalic-branch','left-carotid-branch','left-subclavian-branch'];
      add('three-aortic-arch-branches', aorticBranches.every(id => paths[id] && distanceTo(first(id),'aortic-arch') < .12 && last(id).y > first(id).y + .25), aorticBranches.map(id => ({ id, root: first(id).toArray(), parentAxisDistance: distanceTo(first(id),'aortic-arch') })));
      add('aortic-branch-order', first(aorticBranches[0]).x < first(aorticBranches[1]).x && first(aorticBranches[1]).x < first(aorticBranches[2]).x, 'Brachiocephalic, left common carotid, left subclavian in arch progression.');
      const envelopeMesh = new THREE.Mesh(root.userData.ventricularEnvelope);
      envelopeMesh.matrixWorld.copy(root.matrixWorld);
      add('outflow-root-embedding', inMesh(first('aortic-arch'), envelopeMesh) && inMesh(first('pulmonary-trunk'), envelopeMesh) && first('pulmonary-trunk').z > first('aortic-arch').z, 'Both proximal roots embedded in ventricular envelope; pulmonary root anterior. Chamber-specific internal continuity is unmodeled.');
      let anterior = {}, posterior = {}, minimumY = {};
      for (const id of ['left-ventricle','right-ventricle']) {
        const g = meshes[`${id}-surface`].geometry, p = g.attributes.position, ix = g.index;
        anterior[id] = 0; posterior[id] = 0; minimumY[id] = Infinity;
        for (let i = 0; i < ix.count; i += 3) {
          const [a,b,c] = [0,1,2].map(k => new THREE.Vector3().fromBufferAttribute(p, ix.getX(i+k)));
          minimumY[id] = Math.min(minimumY[id], a.y,b.y,c.y);
          const n = b.clone().sub(a).cross(c.clone().sub(a));
          if (n.z > 0) anterior[id] += n.z / 2; else posterior[id] -= n.z / 2;
        }
      }
      add('rv-anterior-lv-apex', anterior['right-ventricle'] > anterior['left-ventricle'] && minimumY['left-ventricle'] < minimumY['right-ventricle'] -.08, { anteriorProjectedAreas: anterior, minimumY });
      add('lv-posterior-majority', posterior['left-ventricle'] > posterior['right-ventricle'], posterior);
      for (const id of ['left-main-coronary-artery','right-coronary-artery']) {
        add(`${id}-aortic-origin`, distanceTo(first(id),'aortic-arch') < .25 && first(id).y < .8, { root: first(id).toArray(), axisDistance: distanceTo(first(id),'aortic-arch') });
      }
      const expectedConnections = [
        ['left-anterior-descending-artery','left-main-coronary-artery','artery'],
        ['left-circumflex-artery','left-main-coronary-artery','artery'],
        ['first-diagonal-branch','left-anterior-descending-artery','artery'],
        ['second-diagonal-branch','left-anterior-descending-artery','artery'],
        ['obtuse-marginal-branch','left-circumflex-artery','artery'],
        ['right-marginal-branch','right-coronary-artery','artery'],
        ['posterior-descending-artery','right-coronary-artery','artery'],
        ['great-cardiac-vein','coronary-sinus','vein'],
        ['middle-cardiac-vein','coronary-sinus','vein'],
        ['small-cardiac-vein','coronary-sinus','vein'],
      ];
      for (const [id, parent, kind] of expectedConnections) {
        const metadata = nodes[id]?.userData.anatomy;
        const present = paths[id] && paths[parent];
        const gap = present ? distanceTo(kind === 'vein' ? last(id) : first(id), parent) : null;
        add(`${id}-connection`, present && gap < .018 && metadata?.parentVessel === parent && metadata?.kind === kind, { expectedParent: parent, declaredParent: metadata?.parentVessel, centerlineGap: gap });
      }
      const ringRadius = (id, end) => {
        const geometry = meshes[`${id}-wall`].geometry;
        const params = geometry.parameters;
        const row = end ? params.tubularSegments : 0;
        const center = params.path.getPointAt(end ? 1 : 0);
        const point = new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, row * (params.radialSegments + 1));
        return point.distanceTo(center);
      };
      const rcaCruxRadius = ringRadius('right-coronary-artery', true);
      const pdaOriginRadius = ringRadius('posterior-descending-artery', false);
      add('rca-pda-caliber-transition', rcaCruxRadius >= pdaOriginRadius * .98, { rcaCruxRadius, pdaOriginRadius, scope: 'Avoid an abruptly enlarged PDA sprouting from a pinched RCA in this normal teaching example; not a patient-specific caliber rule.' });
      add('coronary-sinus-to-ra', chamber('right-atrium', last('coronary-sinus')), { outlet: last('coronary-sinus').toArray() });
      for (const id of ['right-coronary-artery','left-circumflex-artery','coronary-sinus']) {
        const minY = Math.min(...paths[id].map(p => p[1]));
        add(`${id}-basal-course`, minY > -.6, { minimumY: minY });
      }
      for (const [id, sign] of [['left-anterior-descending-artery',1],['posterior-descending-artery',-1]]) {
        const points = paths[id].filter(p => p[1] < -.55 && p[1] > -1.6);
        add(`${id}-iv-course`, points.length > 30 && points.every(p => p[2]*sign > .15) && last(id).y < -1.7, { terminal: last(id).toArray(), sampledPoints: points.length });
      }
      const greatVeinMaxY = Math.max(...paths['great-cardiac-vein'].map(p => p[1]));
      add('great-cardiac-vein-reaches-basal-av-groove', greatVeinMaxY > .1, { maximumY: greatVeinMaxY, reference: 'Model anterior AV groove near y=+0.23; the vein must ascend there before turning left.' });
      for (const id of ['left-circumflex-artery','left-anterior-descending-artery','great-cardiac-vein']) {
        let buried = 0, samples = 0;
        const buriedPoints = [];
        for (let i = 8; i < paths[id].length - 8; i += 12) {
          if (inMesh(v(paths[id][i]), envelopeMesh)) { buried++; buriedPoints.push({ i, point: paths[id][i] }); }
          samples++;
        }
        add(`${id}-surface-continuity`, buried === 0, { buriedCenterlineSamples: buried, buriedPoints, samples, method: 'Three-direction ray parity against the actual closed ventricular envelope. Proximal/distal endpoints omitted.' });
      }
      return { model: root.name, buildPass: root.userData.buildPass, checks, centerlines: paths,
        scope: 'Geometry and topology checks of an external teaching model; not a clinical validation.',
        unverified: ['internal chamber-specific outflow continuity','valves','septa','patent lumens','hemodynamics','patient-specific dimensions'] };
    });
    checkSnapshot();
    const centerlines = result.centerlines;
    delete result.centerlines;
    const passed = result.checks.every(check => check.passed) && errors.length === 0;
    fs.writeFileSync(path.join(output, 'anatomy-centerlines.json'), JSON.stringify(centerlines));
    if (hash(fs.readFileSync(path.join(output, 'report.json'))) !== hash(captureBytes)) throw new Error('Capture report changed during verification');
    fs.writeFileSync(path.join(output, 'anatomy-check.json'), JSON.stringify({ passed, stage, errors, captureReportSha256: hash(captureBytes), verifierSha256: hash(fs.readFileSync(__filename)), sourceHashes: capture.servedSources, ...result }, null, 2));
    console.log(JSON.stringify({ passed, checks: result.checks.length, failed: result.checks.filter(check => !check.passed), errors }));
    if (!passed) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => {
  if (reportPath && fs.existsSync(path.dirname(reportPath))) fs.writeFileSync(reportPath, JSON.stringify({ passed: false, status: 'failed', failure: String(error) }, null, 2));
  console.error(error); process.exitCode = 1;
});
