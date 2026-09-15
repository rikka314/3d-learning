import * as THREE from 'three';

export type MaterialId = 'myocardium' | 'arterial' | 'venous' | 'atrial' | 'fat' | 'coronaryRed' | 'coronaryBlue';

type SurfaceProfile = {
  colorVariation: number;
  relief: number;
  grainScale: number;
  roughnessVariation: number;
  fiber: number;
};

// Object-space detail avoids magnified crop pixels, mirrored tiles and UV seams.
// These are restrained appearance cues, not visible cells or measured tissue optics.
const surfaceFunctions = /* glsl */ `
  varying vec3 vHeartSurface;
  uniform vec4 uHeartSurface;
  uniform float uHeartFiber;
  uniform float uHeartDetail;

  float heartHash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }
  float heartNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f*f*(3.0-2.0*f);
    return mix(mix(mix(heartHash(i), heartHash(i+vec3(1,0,0)), f.x),
                   mix(heartHash(i+vec3(0,1,0)), heartHash(i+vec3(1,1,0)), f.x), f.y),
               mix(mix(heartHash(i+vec3(0,0,1)), heartHash(i+vec3(1,0,1)), f.x),
                   mix(heartHash(i+vec3(0,1,1)), heartHash(i+vec3(1,1,1)), f.x), f.y), f.z);
  }
  vec3 heartMicroNormal(vec3 surfaceNormal, float height) {
    vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
    vec3 rx = cross(sy, surfaceNormal), ry = cross(surfaceNormal, sx);
    float determinant = dot(sx, rx);
    vec3 gradient = sign(determinant) * (dFdx(height)*rx + dFdy(height)*ry);
    // Avoid unstable derivatives at silhouettes and degenerate rasterized triangles.
    return normalize(surfaceNormal - gradient / max(abs(determinant), 1e-8));
  }
`;

/** Cloneable shader extension: part highlighting retains the same tissue surface. */
class HeartSurfaceMaterial extends THREE.MeshPhysicalMaterial {
  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms): void {
    const profile = this.userData.surfaceProfile as SurfaceProfile;
    shader.uniforms.uHeartSurface = { value: new THREE.Vector4(
      profile.colorVariation, profile.relief, profile.grainScale, profile.roughnessVariation,
    ) };
    shader.uniforms.uHeartFiber = { value: profile.fiber };
    shader.uniforms.uHeartDetail = { value: this.userData.surfaceDetail ?? 1 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHeartSurface;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeartSurface = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${surfaceFunctions}`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        vec3 heartP = vHeartSurface;
        float heartBroad = heartNoise(heartP * 3.5 + vec3(2.7, 4.1, 1.3));
        float heartMedium = heartNoise(heartP * 16.0);
        float heartGrain = heartNoise(heartP * uHeartSurface.z);
        float heartPhase = heartP.y * 150.0 + heartP.x * 27.0
          + 8.0 * heartNoise(heartP * 8.0) + heartP.z * 22.0;
        float heartFrequency = max(fwidth(heartPhase), 0.0001);
        float heartFiber = sin(heartPhase) * (1.0 - smoothstep(0.7, 2.6, heartFrequency));
        float heartVariation = (heartBroad - 0.5) * 1.3 + (heartMedium - 0.5) * 0.32
          + (heartGrain - 0.5) * 0.08 + heartFiber * uHeartFiber * 0.055;
        diffuseColor.rgb *= 1.0 + heartVariation * uHeartSurface.x * uHeartDetail;
        // Very small hue variation under a continuous smooth outer surface.
        diffuseColor.rgb *= mix(vec3(1.0), vec3(1.025, 0.97, 0.955),
          heartBroad * uHeartSurface.x * uHeartDetail);
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (heartMedium - 0.5)
          * uHeartSurface.w * uHeartDetail, 0.20, 0.85);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        #include <normal_fragment_maps>
        float heartHeight = ((heartGrain - 0.5) * 0.70
          + heartFiber * uHeartFiber * 0.12) * uHeartSurface.y * uHeartDetail;
        normal = heartMicroNormal(normal, heartHeight);
      `);
  }

  override customProgramCacheKey(): string { return 'heart-surface-20260906-v1'; }
}

/** PBR appearance estimates. All anatomical structure remains in the model geometry. */
export function createHeartMaterials(): {
  materials: Record<MaterialId, THREE.MeshPhysicalMaterial>;
  ready: Promise<void>;
} {
  const definitions: Record<MaterialId, {
    color: number; roughness: number; coat: number; coatRoughness: number; profile: SurfaceProfile;
  }> = {
    myocardium: { color: 0xb74039, roughness: 0.40, coat: 0.32, coatRoughness: 0.25,
      profile: { colorVariation: 0.21, relief: 0.00065, grainScale: 72, roughnessVariation: 0.09, fiber: 1 } },
    atrial: { color: 0xbd5c54, roughness: 0.43, coat: 0.30, coatRoughness: 0.27,
      profile: { colorVariation: 0.18, relief: 0.00060, grainScale: 80, roughnessVariation: 0.09, fiber: 0.65 } },
    arterial: { color: 0xc53026, roughness: 0.33, coat: 0.38, coatRoughness: 0.22,
      profile: { colorVariation: 0.11, relief: 0.00030, grainScale: 86, roughnessVariation: 0.05, fiber: 0.15 } },
    venous: { color: 0x285b9c, roughness: 0.35, coat: 0.33, coatRoughness: 0.25,
      profile: { colorVariation: 0.13, relief: 0.00026, grainScale: 90, roughnessVariation: 0.05, fiber: 0.12 } },
    fat: { color: 0xe5b66a, roughness: 0.48, coat: 0.21, coatRoughness: 0.30,
      profile: { colorVariation: 0.15, relief: 0.00085, grainScale: 54, roughnessVariation: 0.10, fiber: 0 } },
    coronaryRed: { color: 0xaf211d, roughness: 0.33, coat: 0.34, coatRoughness: 0.24,
      profile: { colorVariation: 0.09, relief: 0.00012, grainScale: 90, roughnessVariation: 0.04, fiber: 0 } },
    coronaryBlue: { color: 0x204a80, roughness: 0.35, coat: 0.32, coatRoughness: 0.25,
      profile: { colorVariation: 0.10, relief: 0.00012, grainScale: 90, roughnessVariation: 0.04, fiber: 0 } },
  };
  const materials = {} as Record<MaterialId, THREE.MeshPhysicalMaterial>;
  for (const id of Object.keys(definitions) as MaterialId[]) {
    const d = definitions[id];
    const material = new HeartSurfaceMaterial({
      name: id, color: d.color, roughness: d.roughness, metalness: 0,
      clearcoat: d.coat, clearcoatRoughness: d.coatRoughness,
      ior: 1.38, specularIntensity: 0.78, envMapIntensity: 0.65,
      dithering: true,
    });
    material.userData.surfaceProfile = d.profile;
    material.userData.surfaceDetail = 1;
    material.userData.appearance = 'Procedural continuous surface; no anatomical displacement or cell-scale claim';
    materials[id] = material;
  }
  // Keep the existing async viewer contract; these materials need no bitmap downloads.
  return { materials, ready: Promise.resolve() };
}
