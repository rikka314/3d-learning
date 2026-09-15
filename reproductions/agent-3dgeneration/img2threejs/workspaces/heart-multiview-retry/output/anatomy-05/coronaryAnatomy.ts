import * as THREE from 'three';
import type { MaterialId } from './heartMaterials';

type VesselKind = 'artery' | 'vein';

type AnatomyMetadata = {
  kind: VesselKind;
  parentVessel?: string;
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

  function addVessel(definition: VesselDefinition): THREE.Group {
    const node = group(definition.id, definition.label, definition.parent);
    const anatomy: AnatomyMetadata = {
      kind: definition.kind,
      parentVessel: definition.parentVessel,
      region: definition.region,
      note: definition.note,
    };
    if (!anatomy.parentVessel) delete anatomy.parentVessel;
    node.userData.anatomy = anatomy;
    const curve = curveThrough(definition.points);
    const wall = mesh(
      `${definition.id}-wall`,
      node,
      tubeGeometry(curve, definition.radii, definition.segments ?? 72, 10),
      definition.kind === 'artery' ? materials.coronaryRed : materials.coronaryBlue,
    );
    wall.userData.anatomy = { ...anatomy };
    return node;
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
      [avArteryY(4.05), 4.05, 0.020],
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
    radii: [0.039, 0.037, 0.033, 0.028, 0.023, 0.017, 0.008],
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
        [-0.54, 2.50, 0.032],
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

  const fat = group('epicardial-fat', '心外膜沟内脂肪');
  const avFat = group('atrioventricular-groove-fat', '房室沟脂肪细带', fat);
  const anteriorIvFat = group('anterior-interventricular-fat', '前室间沟脂肪细带', fat);
  const posteriorIvFat = group('posterior-interventricular-fat', '后室间沟脂肪细带', fat);

  function addFatBand(
    id: string,
    parent: THREE.Group,
    points: THREE.Vector3[],
    radii: number[],
  ): void {
    mesh(id, parent, tubeGeometry(curveThrough(points), radii, 64, 9), materials.fat);
  }

  addFatBand('atrioventricular-groove-fat-band', avFat, surfaceSweep([
    [avGrooveY(0.28), 0.28, 0.004],
    [avGrooveY(5.72), 5.72, 0.004],
    [avGrooveY(5.10), 5.10, 0.004],
    [avGrooveY(4.48), 4.48, 0.004],
    [avGrooveY(3.86), 3.86, 0.004],
    [avGrooveY(3.18), 3.18, 0.004],
    [avGrooveY(2.62), 2.62, 0.004],
  ]), [0.055, 0.062, 0.058, 0.050, 0.036]);
  addFatBand('anterior-interventricular-fat-band', anteriorIvFat, [
    surfaceAt(0.16, anteriorAngle(0.16), 0.002),
    surfaceAt(-0.32, anteriorAngle(-0.32), 0.002),
    surfaceAt(-0.82, anteriorAngle(-0.82), 0.002),
    surfaceAt(-1.30, anteriorAngle(-1.30), 0.002),
    surfaceAt(-1.72, anteriorAngle(-1.72), 0.002),
  ], [0.047, 0.052, 0.043, 0.024]);
  addFatBand('posterior-interventricular-fat-band', posteriorIvFat, [
    surfaceAt(-0.43, posteriorAngle(-0.43), 0.002),
    surfaceAt(-0.82, posteriorAngle(-0.82), 0.002),
    surfaceAt(-1.22, posteriorAngle(-1.22), 0.002),
    surfaceAt(-1.62, posteriorAngle(-1.62), 0.002),
  ], [0.044, 0.048, 0.039, 0.020]);

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
