const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BASE_URL = 'http://127.0.0.1:4175';
const SAMPLE_INTERVALS = 500;
const MIN_CLEARANCE = 0.01;
const CORONARY_MIN_CLEARANCE = 0.002;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let reportPath;

// This is a sampled exterior-separation check, not a lumen or blood-flow test.
(async () => {
  const stage = process.argv[2];
  if (!stage || !/^[a-z0-9-]+$/.test(stage)) throw new Error('Pass a captured evidence stage');
  const output = path.join(__dirname, 'output', stage);
  if (!fs.existsSync(output)) throw new Error('Capture stage does not exist');
  reportPath = path.join(output, 'vessel-clearance.json');
  fs.writeFileSync(reportPath, JSON.stringify({ passed: false, status: 'running', stage }));
  const captureBytes = fs.readFileSync(path.join(output, 'report.json'));
  const capture = JSON.parse(captureBytes);
  if (capture.stage !== stage || !Array.isArray(capture.snapshot) || !Array.isArray(capture.servedSources)) {
    throw new Error('Invalid capture report');
  }
  const requiredSources = ['src/createHeartModel.ts', 'src/coronaryAnatomy.ts', 'anatomy-layout.json'];
  if (requiredSources.some(file => !capture.snapshot.some(item => item.file === file)
    || !capture.servedSources.some(item => item.file === file))) {
    throw new Error('Capture lacks required geometry source hashes');
  }
  if (!Array.isArray(capture.errors) || capture.errors.length || capture.invalidVertices !== 0) {
    throw new Error('Capture contains runtime or geometry errors');
  }
  const checkSnapshot = () => {
    for (const item of capture.snapshot) {
      if (hash(fs.readFileSync(path.join(__dirname, item.file))) !== item.sha256) {
        throw new Error(`Stale capture: ${item.file}`);
      }
    }
  };
  checkSnapshot();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${BASE_URL}/?capture=1`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__MODEL_READY__ === true);
    for (const item of capture.servedSources) {
      const response = await page.request.get(`${BASE_URL}/${item.file}?raw`);
      const raw = await response.text();
      const match = raw.match(/^export default ("(?:[^"\\]|\\.)*")/s);
      if (!response.ok() || hash(Buffer.from(match ? JSON.parse(match[1]) : raw)) !== item.sha256) {
        throw new Error(`Served source mismatch: ${item.file}`);
      }
    }
    const result = await page.evaluate(({ intervals, minClearance, coronaryMinClearance }) => {
      const root = window.__MODEL_ROOT__;
      if (root?.name !== 'heart-multiview-retry') throw new Error('Wrong runtime model');
      root.updateMatrixWorld(true);
      const { nodes, meshes } = root.userData.sculptRuntime;
      const greatVesselIds = [
        'aortic-arch', 'brachiocephalic-branch', 'left-carotid-branch', 'left-subclavian-branch',
        'pulmonary-trunk', 'right-pulmonary-branch', 'left-pulmonary-branch',
        'superior-vena-cava', 'inferior-vena-cava',
        'right-superior-pulmonary-vein', 'right-inferior-pulmonary-vein',
        'left-superior-pulmonary-vein', 'left-inferior-pulmonary-vein',
      ];
      const assemblies = ['aortic-system', 'pulmonary-arterial-system', 'vena-cava-system', 'pulmonary-return-system'];
      const actualIds = assemblies.flatMap(id => {
        if (!nodes[id]) throw new Error(`Missing assembly ${id}`);
        return nodes[id].children.filter(node => node.isGroup).map(node => node.name);
      });
      if (actualIds.length !== greatVesselIds.length || greatVesselIds.some(id => !actualIds.includes(id))) {
        throw new Error('Great-vessel inventory differs from the reviewed anatomy contract');
      }
      // Fixed identities prevent an incorrect/missing metadata kind from silently
      // removing an artery-vein pair from this independent anatomical check.
      const coronaryArteryIds = [
        'left-main-coronary-artery', 'left-anterior-descending-artery',
        'first-diagonal-branch', 'second-diagonal-branch', 'left-circumflex-artery',
        'obtuse-marginal-branch', 'right-coronary-artery', 'right-marginal-branch',
        'posterior-descending-artery',
        'lad-surface-branch-1', 'lad-surface-branch-2', 'lad-surface-branch-3',
        'right-marginal-surface-branch-1', 'right-marginal-surface-branch-2',
        'pda-surface-branch-1', 'pda-surface-branch-2',
        'obtuse-marginal-surface-branch-1', 'obtuse-marginal-surface-branch-2',
      ];
      const cardiacVeinIds = [
        'coronary-sinus', 'great-cardiac-vein', 'middle-cardiac-vein', 'small-cardiac-vein',
        'great-cardiac-surface-tributary-1', 'great-cardiac-surface-tributary-2',
        'middle-cardiac-surface-tributary-1', 'middle-cardiac-surface-tributary-2',
      ];
      for (const [assemblyId, requiredIds] of [
        ['coronary-arteries', coronaryArteryIds], ['cardiac-veins', cardiacVeinIds],
      ]) {
        const assembly = nodes[assemblyId];
        if (!assembly) throw new Error(`Missing coronary assembly: ${assemblyId}`);
        const actual = [];
        assembly.traverse(node => { if (node.isMesh && node.geometry?.parameters?.path) actual.push(node.name); });
        if (actual.length !== requiredIds.length || requiredIds.some(id => !actual.includes(`${id}-wall`))) {
          throw new Error(`Coronary vessel inventory differs from the reviewed anatomy contract: ${assemblyId}`);
        }
      }
      const allVesselIds = [...greatVesselIds, ...coronaryArteryIds, ...cardiacVeinIds];
      const vessels = allVesselIds.map(id => {
        const wall = meshes[`${id}-wall`];
        const geometry = wall?.geometry;
        const params = geometry?.parameters;
        const curve = params?.path;
        if (!curve || !Number.isInteger(params.tubularSegments) || !Number.isInteger(params.radialSegments)) {
          throw new Error(`Missing runtime tube geometry: ${id}`);
        }
        const rows = params.tubularSegments;
        const stride = params.radialSegments + 1;
        const position = geometry.attributes.position;
        if (position.count !== (rows + 1) * stride) throw new Error(`Unexpected tube topology: ${id}`);
        const localPoint = point => root.worldToLocal(wall.localToWorld(point));
        // The builder changes TubeGeometry's vertex radii after construction. Read
        // each rendered ring instead of trusting parameters.radius or layout metadata.
        const radii = Array.from({ length: rows + 1 }, (_, row) => {
          const center = localPoint(curve.getPointAt(row / rows));
          let radius = 0;
          for (let side = 0; side < stride; side++) {
            const point = center.clone().fromBufferAttribute(position, row * stride + side);
            radius = Math.max(radius, localPoint(point).distanceTo(center));
          }
          if (!Number.isFinite(radius) || radius <= 0) throw new Error(`Invalid tube radius: ${id}`);
          return radius;
        });
        const samples = Array.from({ length: intervals + 1 }, (_, i) => {
          const t = i / intervals;
          const row = t * rows;
          const lo = Math.min(Math.floor(row), rows - 1);
          const radius = radii[lo] + (radii[lo + 1] - radii[lo]) * (row - lo);
          const point = localPoint(curve.getPointAt(t));
          if (![point.x, point.y, point.z, radius].every(Number.isFinite)) throw new Error(`Non-finite sample: ${id}`);
          return { point, radius, t };
        });
        let sampleMargin = 0;
        for (let i = 1; i < samples.length; i++) {
          sampleMargin = Math.max(sampleMargin, samples[i].point.distanceTo(samples[i - 1].point)
            + Math.abs(samples[i].radius - samples[i - 1].radius));
        }
        return { id, samples, sampleMargin, radiusRange: [Math.min(...radii), Math.max(...radii)] };
      });
      const byId = new Map(vessels.map(vessel => [vessel.id, vessel]));
      const pairKey = (a, b) => [a, b].sort().join('|');
      const legitimateJunctions = new Map([
        ['aortic-arch', 'brachiocephalic-branch', 'aortic daughter branch'],
        ['aortic-arch', 'left-carotid-branch', 'aortic daughter branch'],
        ['aortic-arch', 'left-subclavian-branch', 'aortic daughter branch'],
        ['pulmonary-trunk', 'right-pulmonary-branch', 'pulmonary daughter branch'],
        ['pulmonary-trunk', 'left-pulmonary-branch', 'pulmonary daughter branch'],
        ['left-pulmonary-branch', 'right-pulmonary-branch', 'shared pulmonary bifurcation'],
      ].map(([a, b, reason]) => [pairKey(a, b), reason]));
      const pairs = [];
      const exclusions = [];
      function scanPair(a, b, group, minimumClearance) {
        let nearest = { gap: Infinity };
        for (const p of a.samples) {
          for (const q of b.samples) {
            const centerDistance = p.point.distanceTo(q.point);
            const gap = centerDistance - p.radius - q.radius;
            if (gap < nearest.gap) nearest = {
              gap, centerDistance, radiusSum: p.radius + q.radius,
              a: { t: p.t, point: p.point.toArray(), radius: p.radius },
              b: { t: q.t, point: q.point.toArray(), radius: q.radius },
            };
          }
        }
        const samplingAllowance = a.sampleMargin + b.sampleMargin;
        const passed = nearest.gap > minimumClearance + samplingAllowance;
        pairs.push({ group, vessels: [a.id, b.id], passed, minimumClearance, samplingAllowance,
          status: passed ? 'separated-at-sampled-resolution' : nearest.gap < 0 ? 'overlap-candidate' : 'needs-finer-review',
          nearest });
      }
      for (let i = 0; i < greatVesselIds.length; i++) {
        for (let j = i + 1; j < greatVesselIds.length; j++) {
          const a = byId.get(greatVesselIds[i]), b = byId.get(greatVesselIds[j]);
          const reason = legitimateJunctions.get(pairKey(a.id, b.id));
          if (reason) { exclusions.push({ group: 'great-vessels', vessels: [a.id, b.id], reason }); continue; }
          scanPair(a, b, 'great-vessels', minClearance);
        }
      }
      // A normal coronary artery has no direct anatomical lumen connection to
      // these named cardiac veins. Same-kind parent/daughter vessels are outside
      // this scan so legitimate arterial branching and venous confluence remain.
      for (const arteryId of coronaryArteryIds) {
        for (const veinId of cardiacVeinIds) {
          scanPair(byId.get(arteryId), byId.get(veinId), 'coronary-artery-vs-vein', coronaryMinClearance);
        }
      }
      pairs.sort((a, b) => a.nearest.gap - b.nearest.gap);
      const groups = ['great-vessels', 'coronary-artery-vs-vein'].map(id => {
        const groupPairs = pairs.filter(pair => pair.group === id);
        return { id, testedPairs: groupPairs.length, passed: groupPairs.every(pair => pair.passed),
          failedPairs: groupPairs.filter(pair => !pair.passed).length,
          minimumGap: groupPairs[0].nearest.gap };
      });
      return {
        model: root.name, buildPass: root.userData.buildPass,
        source: 'Live TubeGeometry.parameters.path and measured rendered vertex-ring radii',
        coordinates: 'Model-root local units; common root depth scale is removed from both centerlines and tube vertices',
        method: '501 evenly spaced arc samples per centerline; max ring radius; interpolated actual ring radii; extra sampling allowance',
        limitations: ['Sampled broad-phase separation, not exact triangle-intersection proof',
          'Legitimate branch pairs excluded from separation testing; their junction quality is tested separately',
          'Coronary same-kind pairs and coronary-to-great-vessel pairs are outside this separation scan',
          'No claims about vessel lumens, chamber continuity, blood flow, or patient-specific dimensions'],
        intervals, minClearance, coronaryMinClearance, groups,
        vessels: vessels.map(({ id, radiusRange, sampleMargin }) => ({ id, radiusRange, sampleMargin })),
        exclusions, pairs,
      };
    }, { intervals: SAMPLE_INTERVALS, minClearance: MIN_CLEARANCE, coronaryMinClearance: CORONARY_MIN_CLEARANCE });
    checkSnapshot();
    if (hash(fs.readFileSync(path.join(output, 'report.json'))) !== hash(captureBytes)) {
      throw new Error('Capture report changed during verification');
    }
    const passed = errors.length === 0 && result.pairs.every(pair => pair.passed);
    fs.writeFileSync(reportPath, JSON.stringify({ passed, status: 'complete', stage, errors,
      captureReportSha256: hash(captureBytes), sourceHashes: capture.servedSources,
      verifierSha256: hash(fs.readFileSync(__filename)), ...result }, null, 2));
    console.log(JSON.stringify({ stage, passed, vessels: result.vessels.length,
      testedPairs: result.pairs.length, excludedPairs: result.exclusions.length,
      groups: result.groups, nearestPair: result.pairs[0],
      failedPairs: result.pairs.filter(pair => !pair.passed), errors }));
    if (!passed) process.exitCode = 1;
  } finally {
    await browser.close();
  }
})().catch(error => {
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify({ passed: false, status: 'failed', failure: String(error) }, null, 2));
  console.error(error);
  process.exitCode = 1;
});
