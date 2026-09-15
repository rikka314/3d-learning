import * as THREE from 'three';
import type { MaterialId } from './heartMaterials';

type VesselKind = 'artery' | 'vein';

type AnatomyMetadata = {
  kind: VesselKind;
  parentVessel?: string;
  illustrative?: boolean;
  region: string;
  note: string;
};

export type CoronaryAnatomyContext = {
  group: (id: string, label: string, parent?: THREE.Object3D) => THREE.Group;
  mesh: (
    id: string,
    parent: THREE.Group,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
  ) => THREE.Mesh;
  materials: Record<MaterialId, THREE.MeshPhysicalMaterial>;
  tubeGeometry: (
    curve: THREE.Curve<THREE.Vector3>,
    radii: number[],
    segments: number,
    sides: number,
  ) => THREE.BufferGeometry;
  surfaceAt: (y: number, theta: number, offset?: number) => THREE.Vector3;
  anteriorAngle: (y: number) => number;
  posteriorAngle: (y: number) => number;
};

type VesselDefinition = {
  id: string;
  label: string;
  kind: VesselKind;
  parent: THREE.Group;
  parentVessel?: string;
  illustrative?: boolean;
  region: string;
  note: string;
  points: THREE.Vector3[];
  radii: number[];
  segments?: number;
};

type SurfaceStation = readonly [y: number, theta: number, offset: number];

const ARTERY_COLOR_NOTE = '教学配色为红色；动脉身份依据其主动脉起源、分支关系与心外膜走行判定。';
const VEIN_COLOR_NOTE = '教学配色为蓝色；静脉身份依据其汇流方向、属支关系及向右心房回流判定。';

function curveThrough(points: THREE.Vector3[]): THREE.CatmullRomCurve3 {
  return new THREE.CatmullRomCurve3(points.map((point) => point.clone()), false, 'centripetal');
}

/**
 * Adds a simplified, right-dominant epicardial coronary circulation.
 * The layout is an educational surface map: vessel identity comes from origin,
 * course, branching, and drainage rather than the red/blue teaching colors.
 */
export function buildCoronaryAnatomy(ctx: CoronaryAnatomyContext): void {
  const {
    group,
    mesh,
    materials,
    tubeGeometry,
    surfaceAt,
    anteriorAngle,
    posteriorAngle,
  } = ctx;

  const coronaries = group('coronary-network', '冠状动静脉（右冠优势教学示意）');
  const arteries = group('coronary-arteries', '冠状动脉', coronaries);
  const leftSystem = group('left-coronary-system', '左冠状动脉系统', arteries);
  const rightSystem = group('right-coronary-system', '右冠状动脉系统（优势型）', arteries);
  const veins = group('cardiac-veins', '心静脉与冠状窦', coronaries);
  const vesselCurves = new Map<string, THREE.CatmullRomCurve3>();

  function addVessel(definition: VesselDefinition): THREE.Group {
    const node = group(definition.id, definition.label, definition.parent);
    const anatomy: AnatomyMetadata = {
      kind: definition.kind,
      parentVessel: definition.parentVessel,
      illustrative: definition.illustrative,
      region: definition.region,
      note: definition.note,
    };
    if (!anatomy.parentVessel) delete anatomy.parentVessel;
    if (!anatomy.illustrative) delete anatomy.illustrative;
    node.userData.anatomy = anatomy;
    const curve = curveThrough(definition.points);
    vesselCurves.set(definition.id, curve);
    const wall = mesh(
      `${definition.id}-wall`,
      node,
      tubeGeometry(curve, definition.radii, definition.segments ?? 72, 10),
      definition.kind === 'artery' ? materials.coronaryRed : materials.coronaryBlue,
    );
    wall.userData.anatomy = { ...anatomy };
    return node;
  }

  function closestPointOnVessel(vesselId: string, targetY: number): THREE.Vector3 {
    const curve = vesselCurves.get(vesselId);
    if (!curve) throw new Error(`Missing parent vessel curve: ${vesselId}`);
    let nearest = curve.getPointAt(0);
    let nearestDelta = Math.abs(nearest.y - targetY);
    for (let index = 1; index <= 800; index++) {
      const candidate = curve.getPointAt(index / 800);
      const delta = Math.abs(candidate.y - targetY);
      if (delta < nearestDelta) {
        nearest = candidate;
        nearestDelta = delta;
      }
    }
    return nearest.clone();
  }

  /**
   * Densely samples the epicardial surface instead of letting a sparse spline cut
   * through the ventricular volume. Angles are unwrapped over the shortest arc,
   * which keeps paths continuous across the 0/2π seam.
   */
  function surfaceSweep(stations: SurfaceStation[]): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (let index = 0; index < stations.length - 1; index++) {
      const [startY, startTheta, startOffset] = stations[index];
      const [endY, endTheta, endOffset] = stations[index + 1];
      const thetaDelta = Math.atan2(Math.sin(endTheta - startTheta), Math.cos(endTheta - startTheta));
      const steps = Math.max(2, Math.ceil(Math.max(
        Math.abs(endY - startY) / 0.055,
        Math.abs(thetaDelta) / 0.055,
      )));
      for (let step = index === 0 ? 0 : 1; step <= steps; step++) {
        const t = step / steps;
        points.push(surfaceAt(
          THREE.MathUtils.lerp(startY, endY, t),
          startTheta + thetaDelta * t,
          THREE.MathUtils.lerp(startOffset, endOffset, t),
        ));
      }
    }
    return points;
  }

  const avGrooveY = (theta: number): number => -0.07 + 0.30 * Math.sin(theta);
  const avArteryY = (theta: number): number => avGrooveY(theta) - 0.040;
  const avVeinY = (theta: number): number => avGrooveY(theta) + 0.090;

  // Both daughter vessels start at this exact point so the left main visibly bifurcates.
  const leftMainOrigin = new THREE.Vector3(-0.20, 0.58, 0.06);
  const leftBifurcation = surfaceAt(0.20, anteriorAngle(0.20), 0.040);
  addVessel({
    id: 'left-main-coronary-artery',
    label: '左冠状动脉主干',
    kind: 'artery',
    parent: leftSystem,
    region: '主动脉根部至左冠分叉',
    note: `短主干由左主动脉窦区域走向 LAD 与 LCx 的共同分叉。${ARTERY_COLOR_NOTE}`,
    points: [leftMainOrigin, new THREE.Vector3(0.04, 0.48, 0.45), leftBifurcation],
    radii: [0.039, 0.037, 0.034],
    segments: 34,
  });

  const ladDiagonalOneOrigin = surfaceAt(-0.46, anteriorAngle(-0.46), 0.038);
  const ladDiagonalTwoOrigin = surfaceAt(-1.02, anteriorAngle(-1.02), 0.034);
  const ladPoints = [
    leftBifurcation,
    ...surfaceSweep([
      [0.20, anteriorAngle(0.20), 0.040],
      [-0.10, anteriorAngle(-0.10), 0.040],
      [-0.46, anteriorAngle(-0.46), 0.038],
      [-0.73, anteriorAngle(-0.73), 0.035],
      [-1.02, anteriorAngle(-1.02), 0.034],
      [-1.34, anteriorAngle(-1.34), 0.030],
      [-1.68, anteriorAngle(-1.68), 0.026],
      [-2.03, anteriorAngle(-2.03), 0.020],
    ]).slice(1),
  ];
  addVessel({
    id: 'left-anterior-descending-artery',
    label: '前室间支（LAD）',
    kind: 'artery',
    parent: leftSystem,
    parentVessel: 'left-main-coronary-artery',
    region: '前室间沟至心尖附近',
    note: `沿前室间沟下行；其心尖方向走行不代表 LCx 延伸。${ARTERY_COLOR_NOTE}`,
    points: ladPoints,
    radii: [0.034, 0.032, 0.028, 0.024, 0.019, 0.013, 0.005],
    segments: 96,
  });

  addVessel({
    id: 'first-diagonal-branch',
    label: '第一对角支',
    kind: 'artery',
    parent: leftSystem,
    parentVessel: 'left-anterior-descending-artery',
    region: '左心室前外侧壁',
    note: `自 LAD 分出并斜向解剖左侧，不跨越心尖。${ARTERY_COLOR_NOTE}`,
    points: [
      ladDiagonalOneOrigin,
      surfaceAt(-0.58, 1.13, 0.029),
      surfaceAt(-0.78, 0.82, 0.022),
      surfaceAt(-0.92, 0.60, 0.016),
    ],
    radii: [0.019, 0.015, 0.010, 0.003],
    segments: 44,
  });
  addVessel({
    id: 'second-diagonal-branch',
    label: '第二对角支',
    kind: 'artery',
    parent: leftSystem,
    parentVessel: 'left-anterior-descending-artery',
    region: '左心室中下段前外侧壁',
    note: `自 LAD 中段分出，终止于左心室前外侧壁。${ARTERY_COLOR_NOTE}`,
    points: [
      ladDiagonalTwoOrigin,
      surfaceAt(-1.12, 1.18, 0.026),
      surfaceAt(-1.32, 0.91, 0.018),
      surfaceAt(-1.48, 0.72, 0.012),
    ],
    radii: [0.016, 0.012, 0.008, 0.003],
    segments: 40,
  });

  const obtuseMarginalOrigin = surfaceAt(avArteryY(5.23), 5.23, 0.033);
  const circumflexPoints = [
    leftBifurcation,
    ...surfaceSweep([
      [0.20, anteriorAngle(0.20), 0.040],
      [avArteryY(0.80), 0.80, 0.040],
      [avArteryY(0.20), 0.20, 0.039],
      [avArteryY(5.84), 5.84, 0.038],
      [avArteryY(5.60), 5.60, 0.036],
      [avArteryY(5.23), 5.23, 0.033],
      [avArteryY(4.72), 4.72, 0.030],
      [avArteryY(4.60), 4.60, 0.020],
    ]).slice(1),
  ];
  addVessel({
    id: 'left-circumflex-artery',
    label: '左回旋支（LCx）',
    kind: 'artery',
    parent: leftSystem,
    parentVessel: 'left-main-coronary-artery',
    region: '左侧至后方房室沟',
    note: `沿左房室沟绕向后方并在后外侧终止；本右冠优势示意中不形成 PDA，也不下行至心尖。${ARTERY_COLOR_NOTE}`,
    points: circumflexPoints,
    radii: [0.033, 0.031, 0.027, 0.022, 0.016, 0.006],
    segments: 82,
  });
  addVessel({
    id: 'obtuse-marginal-branch',
    label: '钝缘支',
    kind: 'artery',
    parent: leftSystem,
    parentVessel: 'left-circumflex-artery',
    region: '左心室外侧壁',
    note: `自 LCx 的左外侧段分出并向左心室外侧壁下行。${ARTERY_COLOR_NOTE}`,
    points: [
      obtuseMarginalOrigin,
      surfaceAt(-0.58, 5.43, 0.026),
      surfaceAt(-0.93, 5.56, 0.019),
      surfaceAt(-1.25, 5.62, 0.011),
    ],
    radii: [0.018, 0.014, 0.009, 0.003],
    segments: 46,
  });

  const rightOrigin = new THREE.Vector3(-0.45, 0.60, 0.06);
  const rightMarginalOrigin = surfaceAt(avArteryY(2.95), 2.95, 0.037);
  const crux = surfaceAt(avArteryY(4.05), 4.05, 0.038);
  addVessel({
    id: 'right-coronary-artery',
    label: '右冠状动脉（RCA）',
    kind: 'artery',
    parent: rightSystem,
    region: '主动脉根部、右房室沟至心脏十字部',
    note: `沿右房室沟到达后方 crux，并在此右冠优势示意中发出 PDA。${ARTERY_COLOR_NOTE}`,
    points: [
      rightOrigin,
      new THREE.Vector3(-0.60, 0.40, 0.42),
      ...surfaceSweep([
        [avArteryY(2.50), 2.50, 0.043],
        [avArteryY(2.72), 2.72, 0.040],
        [avArteryY(2.95), 2.95, 0.037],
        [avArteryY(3.20), 3.20, 0.036],
        [avArteryY(3.62), 3.62, 0.036],
        [avArteryY(4.05), 4.05, 0.038],
      ]),
    ],
    radii: [0.039, 0.037, 0.034, 0.032, 0.030, 0.027, 0.025],
    segments: 90,
  });
  addVessel({
    id: 'right-marginal-branch',
    label: '右缘支',
    kind: 'artery',
    parent: rightSystem,
    parentVessel: 'right-coronary-artery',
    region: '右心室锐缘',
    note: `自 RCA 分出后沿右心室锐缘下行，止于右心室下段，不越过左心室心尖。${ARTERY_COLOR_NOTE}`,
    points: [
      rightMarginalOrigin,
      ...surfaceSweep([
        [avArteryY(2.95), 2.95, 0.037],
        [-0.43, 2.84, 0.032],
        [-0.78, 2.80, 0.026],
        [-1.10, 2.79, 0.018],
        [-1.40, 2.78, 0.010],
      ]).slice(1),
    ],
    radii: [0.021, 0.017, 0.012, 0.007, 0.0025],
    segments: 54,
  });

  addVessel({
    id: 'posterior-descending-artery',
    label: '后室间支（PDA）',
    kind: 'artery',
    parent: rightSystem,
    parentVessel: 'right-coronary-artery',
    region: '后室间沟至心尖附近',
    note: `从 crux 起沿后室间沟下行；由 RCA 发出用于明确表达右冠优势。${ARTERY_COLOR_NOTE}`,
    points: [
      crux,
      ...surfaceSweep([
        [avArteryY(4.05), 4.05, 0.038],
        [-0.66, posteriorAngle(-0.66), 0.033],
        [-0.96, posteriorAngle(-0.96), 0.029],
        [-1.28, posteriorAngle(-1.28), 0.024],
        [-1.58, posteriorAngle(-1.58), 0.018],
        [-1.87, posteriorAngle(-1.87), 0.010],
      ]).slice(1),
    ],
    radii: [0.024, 0.021, 0.017, 0.012, 0.007, 0.0025],
    segments: 72,
  });

  // The sinus runs in the posterior AV groove and drains into the right atrium.
  const sinusLeftEnd = surfaceAt(avVeinY(5.60), 5.60, 0.030);
  const middleVeinJunction = surfaceAt(avVeinY(4.22), 4.22, 0.041);
  const sinusRightJunction = surfaceAt(avVeinY(3.80), 3.80, 0.034);
  addVessel({
    id: 'coronary-sinus',
    label: '冠状窦',
    kind: 'vein',
    parent: veins,
    region: '后方房室沟至右心房',
    note: `位于左后房室沟，是主要心静脉汇流通道，最终直接开口于右心房。${VEIN_COLOR_NOTE}`,
    points: [
      ...surfaceSweep([
        [avVeinY(5.60), 5.60, 0.030],
        [avVeinY(5.18), 5.18, 0.035],
        [avVeinY(4.70), 4.70, 0.035],
        [avVeinY(4.22), 4.22, 0.041],
        [avVeinY(3.80), 3.80, 0.034],
      ]),
      new THREE.Vector3(-0.91, -0.25, -0.47),
    ],
    radii: [0.041, 0.048, 0.052, 0.050, 0.043, 0.029],
    segments: 82,
  });

  addVessel({
    id: 'great-cardiac-vein',
    label: '心大静脉',
    kind: 'vein',
    parent: veins,
    parentVessel: 'coronary-sinus',
    region: '前室间沟、左房室沟至冠状窦左端',
    note: `由心尖附近沿前室间沟伴随 LAD 上行，再转入左房室沟并汇入冠状窦左端。${VEIN_COLOR_NOTE}`,
    points: [
      ...surfaceSweep([
        [-1.95, anteriorAngle(-1.95) + 0.12, 0.030],
        [-1.55, anteriorAngle(-1.55) + 0.12, 0.036],
        [-1.12, anteriorAngle(-1.12) + 0.12, 0.041],
        [-0.68, anteriorAngle(-0.68) + 0.12, 0.045],
        [-0.24, anteriorAngle(-0.24) + 0.12, 0.047],
        [0.14, anteriorAngle(0.14) + 0.12, 0.048],
        [avVeinY(1.40), 1.40, 0.049],
        [avVeinY(1.22), 1.22, 0.049],
        [avVeinY(1.10), 1.10, 0.049],
        [avVeinY(0.80), 0.80, 0.048],
        [avVeinY(0.50), 0.50, 0.047],
        [avVeinY(0.20), 0.20, 0.045],
        [avVeinY(6.05), 6.05, 0.042],
        [avVeinY(5.88), 5.88, 0.038],
        [avVeinY(5.60), 5.60, 0.030],
      ]).slice(0, -1),
      sinusLeftEnd,
    ],
    radii: [0.011, 0.016, 0.021, 0.026, 0.031, 0.034, 0.038],
    segments: 96,
  });

  addVessel({
    id: 'middle-cardiac-vein',
    label: '心中静脉（后室间静脉）',
    kind: 'vein',
    parent: veins,
    parentVessel: 'coronary-sinus',
    region: '后室间沟至冠状窦',
    note: `自心尖后面沿后室间沟伴随 PDA 上行，并汇入冠状窦。${VEIN_COLOR_NOTE}`,
    points: [
      ...surfaceSweep([
        [-1.90, posteriorAngle(-1.90) + 0.18, 0.025],
        [-1.55, posteriorAngle(-1.55) + 0.18, 0.031],
        [-1.17, posteriorAngle(-1.17) + 0.18, 0.037],
        [-0.79, posteriorAngle(-0.79) + 0.18, 0.042],
        [-0.50, posteriorAngle(-0.50) + 0.16, 0.044],
        [avVeinY(4.22), 4.22, 0.041],
      ]).slice(0, -1),
      middleVeinJunction,
    ],
    radii: [0.010, 0.014, 0.019, 0.024, 0.029, 0.034],
    segments: 76,
  });

  addVessel({
    id: 'small-cardiac-vein',
    label: '心小静脉',
    kind: 'vein',
    parent: veins,
    parentVessel: 'coronary-sinus',
    region: '右心室锐缘与右房室沟',
    note: `由右心室边缘回流，转入右房室沟并在后方汇入冠状窦。${VEIN_COLOR_NOTE}`,
    points: [
      ...surfaceSweep([
        [-1.31, 2.45, 0.022],
        [-0.91, 2.48, 0.027],
        [-0.54, 2.45, 0.032],
        [avVeinY(2.35), 2.35, 0.038],
        [avVeinY(2.50), 2.50, 0.038],
        [avVeinY(2.76), 2.76, 0.038],
        [avVeinY(3.08), 3.08, 0.038],
        [avVeinY(3.43), 3.43, 0.038],
        [avVeinY(3.80), 3.80, 0.034],
      ]).slice(0, -1),
      sinusRightJunction,
    ],
    radii: [0.007, 0.011, 0.015, 0.019, 0.024, 0.029],
    segments: 66,
  });

  type SurfaceBranchDefinition = {
    id: string;
    label: string;
    kind: VesselKind;
    parent: THREE.Group;
    parentVessel: string;
    rootY: number;
    stations: SurfaceStation[];
    region: string;
  };

  function addIllustrativeSurfaceBranch(definition: SurfaceBranchDefinition): void {
    const junction = closestPointOnVessel(definition.parentVessel, definition.rootY);
    const surfacePoints = surfaceSweep(definition.stations);
    const points = definition.kind === 'artery'
      ? [junction, ...surfacePoints.slice(1)]
      : [...surfacePoints.slice(0, -1), junction];
    addVessel({
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      parent: definition.parent,
      parentVessel: definition.parentVessel,
      illustrative: true,
      region: definition.region,
      note: `${definition.kind === 'artery' ? '表面次级支' : '表面属支'}由实际母干曲线接合并贴心外膜走行；数量、末梢分布与路线仅用于多视图教学示意，不代表具体个体。${definition.kind === 'artery' ? ARTERY_COLOR_NOTE : VEIN_COLOR_NOTE}`,
      points,
      radii: definition.kind === 'artery'
        ? [0.008, 0.006, 0.003, 0.0008]
        : [0.0008, 0.003, 0.006, 0.008],
      segments: 42,
    });
  }

  const illustrativeBranches: SurfaceBranchDefinition[] = [
    {
      id: 'lad-surface-branch-1', label: 'LAD 表面次级支 1', kind: 'artery', parent: leftSystem,
      parentVessel: 'left-anterior-descending-artery', rootY: -0.32, region: '左心室前壁上段',
      stations: [[-0.32, anteriorAngle(-0.32), 0.022], [-0.47, 0.94, 0.014], [-0.62, 0.65, 0.006]],
    },
    {
      id: 'lad-surface-branch-2', label: 'LAD 表面次级支 2', kind: 'artery', parent: leftSystem,
      parentVessel: 'left-anterior-descending-artery', rootY: -0.78, region: '左心室前壁中段',
      stations: [[-0.78, anteriorAngle(-0.78), 0.021], [-0.93, 1.02, 0.013], [-1.08, 0.80, 0.006]],
    },
    {
      id: 'lad-surface-branch-3', label: 'LAD 表面次级支 3', kind: 'artery', parent: leftSystem,
      parentVessel: 'left-anterior-descending-artery', rootY: -1.42, region: '左心室前壁下段',
      stations: [[-1.42, anteriorAngle(-1.42), 0.019], [-1.57, 0.98, 0.012], [-1.72, 0.70, 0.005]],
    },
    {
      id: 'right-marginal-surface-branch-1', label: '右缘表面次级支 1', kind: 'artery', parent: rightSystem,
      parentVessel: 'right-marginal-branch', rootY: -0.50, region: '右心室右侧壁（锐缘附近）上段',
      stations: [[-0.50, 2.82, 0.019], [-0.65, 3.04, 0.012], [-0.80, 3.28, 0.005]],
    },
    {
      id: 'right-marginal-surface-branch-2', label: '右缘表面次级支 2', kind: 'artery', parent: rightSystem,
      parentVessel: 'right-marginal-branch', rootY: -0.93, region: '右心室右侧壁（锐缘附近）中段',
      stations: [[-0.93, 2.80, 0.018], [-1.08, 3.05, 0.011], [-1.23, 3.32, 0.005]],
    },
    {
      id: 'pda-surface-branch-1', label: 'PDA 表面次级支 1', kind: 'artery', parent: rightSystem,
      parentVessel: 'posterior-descending-artery', rootY: -0.74, region: '右心室膈面上段',
      stations: [[-0.74, posteriorAngle(-0.74), 0.019], [-0.89, 3.78, 0.012], [-1.04, 3.50, 0.005]],
    },
    {
      id: 'pda-surface-branch-2', label: 'PDA 表面次级支 2', kind: 'artery', parent: rightSystem,
      parentVessel: 'posterior-descending-artery', rootY: -1.25, region: '右心室膈面中段',
      stations: [[-1.25, posteriorAngle(-1.25), 0.018], [-1.40, 3.78, 0.011], [-1.55, 3.50, 0.005]],
    },
    {
      id: 'obtuse-marginal-surface-branch-1', label: '钝缘表面次级支 1', kind: 'artery', parent: leftSystem,
      parentVessel: 'obtuse-marginal-branch', rootY: -0.65, region: '左心室外侧壁上段',
      stations: [[-0.65, 5.46, 0.018], [-0.78, 5.73, 0.011], [-0.90, 6.00, 0.005]],
    },
    {
      id: 'obtuse-marginal-surface-branch-2', label: '钝缘表面次级支 2', kind: 'artery', parent: leftSystem,
      parentVessel: 'obtuse-marginal-branch', rootY: -1.00, region: '左心室外侧壁中下段',
      stations: [[-1.00, 5.58, 0.017], [-1.13, 5.80, 0.010], [-1.25, 6.00, 0.004]],
    },
    {
      id: 'great-cardiac-surface-tributary-1', label: '心大静脉表面属支 1', kind: 'vein', parent: veins,
      parentVessel: 'great-cardiac-vein', rootY: -0.48, region: '右心室前壁上段',
      stations: [[-0.73, 1.95, 0.005], [-0.61, 1.69, 0.011], [-0.48, anteriorAngle(-0.48) + 0.12, 0.020]],
    },
    {
      id: 'great-cardiac-surface-tributary-2', label: '心大静脉表面属支 2', kind: 'vein', parent: veins,
      parentVessel: 'great-cardiac-vein', rootY: -1.06, region: '右心室前壁中下段',
      stations: [[-1.31, 1.95, 0.005], [-1.19, 1.69, 0.011], [-1.06, anteriorAngle(-1.06) + 0.12, 0.020]],
    },
    {
      id: 'middle-cardiac-surface-tributary-1', label: '心中静脉表面属支 1', kind: 'vein', parent: veins,
      parentVessel: 'middle-cardiac-vein', rootY: -0.80, region: '左心室膈面上段',
      stations: [[-1.05, 4.85, 0.005], [-0.93, 4.56, 0.011], [-0.80, posteriorAngle(-0.80) + 0.18, 0.020]],
    },
    {
      id: 'middle-cardiac-surface-tributary-2', label: '心中静脉表面属支 2', kind: 'vein', parent: veins,
      parentVessel: 'middle-cardiac-vein', rootY: -1.30, region: '左心室膈面中下段',
      stations: [[-1.55, 4.85, 0.005], [-1.43, 4.56, 0.011], [-1.30, posteriorAngle(-1.30) + 0.18, 0.020]],
    },
  ];
  illustrativeBranches.forEach(addIllustrativeSurfaceBranch);

  const fat = group('epicardial-fat', '心外膜沟内脂肪');
  const avFat = group('atrioventricular-groove-fat', '房室沟脂肪细带', fat);
  const anteriorIvFat = group('anterior-interventricular-fat', '前室间沟脂肪细带', fat);
  const posteriorIvFat = group('posterior-interventricular-fat', '后室间沟脂肪细带', fat);

  type FatStation = readonly [y: number, theta: number];

  function expandFatStations(stations: FatStation[]): FatStation[] {
    const expanded: FatStation[] = [];
    for (let index = 0; index < stations.length - 1; index++) {
      const [startY, startTheta] = stations[index];
      const [endY, endTheta] = stations[index + 1];
      const thetaDelta = Math.atan2(Math.sin(endTheta - startTheta), Math.cos(endTheta - startTheta));
      const steps = Math.max(3, Math.ceil(Math.max(
        Math.abs(endY - startY) / 0.045,
        Math.abs(thetaDelta) / 0.045,
      )));
      for (let step = index === 0 ? 0 : 1; step <= steps; step++) {
        const t = step / steps;
        expanded.push([
          THREE.MathUtils.lerp(startY, endY, t),
          startTheta + thetaDelta * t,
        ]);
      }
    }
    return expanded;
  }

  /**
   * Builds a shallow, open ribbon that follows the ventricular envelope. The
   * seven-point cross-section gives the groove fat a low lobulated crown while
   * keeping its edges nearly flush with the epicardium and below the vessels.
   */
  function addFatBand(
    id: string,
    parent: THREE.Group,
    stations: FatStation[],
    baseWidth: number,
    phase: number,
    taperDistal = false,
  ): void {
    const rows = expandFatStations(stations);
    const centers = rows.map(([y, theta]) => surfaceAt(y, theta, 0.006));
    const positions: number[] = [];
    const normals: THREE.Vector3[] = [];
    const crossSectionColumns = 7;

    rows.forEach(([y, theta], index) => {
      const previous = centers[Math.max(0, index - 1)];
      const next = centers[Math.min(centers.length - 1, index + 1)];
      const tangent = next.clone().sub(previous).normalize();
      const surfaceNormal = surfaceAt(y, theta, 0.020)
        .sub(surfaceAt(y, theta, 0.000))
        .normalize();
      const lateral = new THREE.Vector3().crossVectors(surfaceNormal, tangent).normalize();
      const yDerivative = surfaceAt(y + 0.008, theta, 0).sub(surfaceAt(y - 0.008, theta, 0)).multiplyScalar(62.5);
      const thetaDerivative = surfaceAt(y, theta + 0.008, 0).sub(surfaceAt(y, theta - 0.008, 0)).multiplyScalar(62.5);
      const progress = index / Math.max(rows.length - 1, 1);
      const distalScale = taperDistal
        ? 1 - 0.94 * THREE.MathUtils.smoothstep(progress, 0.72, 1)
        : 1;
      const width = baseWidth * distalScale * (
        1
        + 0.13 * Math.sin(index * 0.71 + phase)
        + 0.055 * Math.sin(index * 1.83 + phase * 1.7)
      );
      const halfWidth = width * 0.5;
      const deltaY = lateral.dot(yDerivative) / Math.max(yDerivative.lengthSq(), 1e-6) * halfWidth;
      const deltaTheta = lateral.dot(thetaDerivative) / Math.max(thetaDerivative.lengthSq(), 1e-6) * halfWidth;
      const crownHeight = 0.0075 + 0.0025 * (0.5 + 0.5 * Math.sin(index * 0.88 + phase));
      const edgeHeight = 0.0035 + 0.001 * (0.5 + 0.5 * Math.sin(index * 1.31 + phase));
      const rowPoints = Array.from({ length: crossSectionColumns }, (_, column) => {
        const lateralFraction = column / (crossSectionColumns - 1) * 2 - 1;
        const crown = Math.max(0, 1 - lateralFraction * lateralFraction);
        const lobule = 0.0007 * crown * Math.sin(index * 0.83 + column * 1.37 + phase);
        const height = THREE.MathUtils.lerp(edgeHeight, crownHeight, crown) + lobule;
        return surfaceAt(
          y + deltaY * lateralFraction,
          theta + deltaTheta * lateralFraction,
          height,
        );
      });
      rowPoints.forEach((point) => positions.push(point.x, point.y, point.z));
      normals.push(surfaceNormal);
    });

    const closed = centers[0].distanceTo(centers.at(-1)!) < 1e-6;
    if (closed) {
      const lastRowOffset = (rows.length - 1) * crossSectionColumns * 3;
      for (let i = 0; i < crossSectionColumns * 3; i++) positions[lastRowOffset + i] = positions[i];
    }

    const indices: number[] = [];
    for (let row = 0; row < rows.length - 1; row++) {
      for (let column = 0; column < crossSectionColumns - 1; column++) {
        const a = row * crossSectionColumns + column;
        const b = (row + 1) * crossSectionColumns + column;
        const c = (row + 1) * crossSectionColumns + column + 1;
        const d = row * crossSectionColumns + column + 1;
        const pa = new THREE.Vector3().fromArray(positions, a * 3);
        const pb = new THREE.Vector3().fromArray(positions, b * 3);
        const pc = new THREE.Vector3().fromArray(positions, c * 3);
        const faceNormal = new THREE.Vector3().crossVectors(pb.sub(pa), pc.sub(pa));
        if (faceNormal.dot(normals[row]) >= 0) {
          indices.push(a, b, c, a, c, d);
        } else {
          indices.push(a, c, b, a, d, c);
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    if (closed) {
      const normalAttribute = geometry.getAttribute('normal');
      const normal = new THREE.Vector3();
      const lastRow = (rows.length - 1) * crossSectionColumns;
      for (let column = 0; column < crossSectionColumns; column++) {
        normal.fromBufferAttribute(normalAttribute, column)
          .add(new THREE.Vector3().fromBufferAttribute(normalAttribute, lastRow + column)).normalize();
        normalAttribute.setXYZ(column, normal.x, normal.y, normal.z);
        normalAttribute.setXYZ(lastRow + column, normal.x, normal.y, normal.z);
      }
    }
    geometry.computeBoundingSphere();
    const patch = mesh(id, parent, geometry, materials.fat);
    patch.userData.anatomy = {
      region: '心外膜沟',
      note: '贴附心外膜的低矮不规则脂肪带；外观宽度与小叶起伏为多视图教学示意。',
      illustrative: true,
    };
  }

  addFatBand('atrioventricular-groove-fat-band', avFat, [
    [avGrooveY(0.42), 0.42],
    [avGrooveY(0.10), 0.10],
    [avGrooveY(5.72), 5.72],
    [avGrooveY(5.10), 5.10],
    [avGrooveY(4.48), 4.48],
    [avGrooveY(3.86), 3.86],
    [avGrooveY(3.18), 3.18],
    [avGrooveY(2.62), 2.62],
    [avGrooveY(2.00), 2.00],
    [avGrooveY(1.40), 1.40],
    [avGrooveY(0.80), 0.80],
    [avGrooveY(0.42), 0.42],
  ], 0.205, 0.4);
  addFatBand('anterior-interventricular-fat-band', anteriorIvFat, [
    [0.16, anteriorAngle(0.16)],
    [-0.32, anteriorAngle(-0.32)],
    [-0.82, anteriorAngle(-0.82)],
    [-1.30, anteriorAngle(-1.30)],
    [-1.72, anteriorAngle(-1.72)],
  ], 0.184, 1.7, true);
  addFatBand('posterior-interventricular-fat-band', posteriorIvFat, [
    [-0.43, posteriorAngle(-0.43)],
    [-0.82, posteriorAngle(-0.82)],
    [-1.22, posteriorAngle(-1.22)],
    [-1.62, posteriorAngle(-1.62)],
  ], 0.166, 2.8, true);

  const lobules = group('epicardial-fat-lobules', '沟内脂肪小叶', fat);
  const lobuleSites = [
    surfaceAt(-0.23, 5.46, 0.018),
    surfaceAt(-0.35, 4.86, 0.018),
    surfaceAt(-0.16, 2.83, 0.018),
    surfaceAt(-0.58, anteriorAngle(-0.58) - 0.10, 0.016),
    surfaceAt(-0.75, posteriorAngle(-0.75) + 0.11, 0.016),
  ];
  lobuleSites.forEach((position, index) => {
    const node = group(`epicardial-fat-lobule-${index + 1}`, `心外膜脂肪小叶 ${index + 1}`, lobules);
    node.position.copy(position);
    const geometry = new THREE.SphereGeometry(1, 12, 8);
    geometry.scale(0.060 + index * 0.004, 0.040 + (index % 2) * 0.009, 0.025);
    mesh(`epicardial-fat-lobule-${index + 1}-surface`, node, geometry, materials.fat);
  });
}
