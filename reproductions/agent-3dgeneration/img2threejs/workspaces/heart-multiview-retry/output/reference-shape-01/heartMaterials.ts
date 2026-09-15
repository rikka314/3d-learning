import * as THREE from 'three';

export type MaterialId = 'myocardium' | 'arterial' | 'venous' | 'atrial' | 'fat' | 'coronaryRed' | 'coronaryBlue';

type SurfaceProfile = {
  colorVariation: number;
  relief: number;
  grainScale: number;
  roughnessVariation: number;
  fiber: number;
  mesoScale: number;
  mesoStrength: number;
};

// Object-space detail avoids magnified crop pixels, mirrored tiles and UV seams.
// These are restrained appearance cues, not visible cells or measured tissue optics.
const surfaceFunctions = /* glsl */ `
  varying vec3 vHeartSurface;
  uniform vec4 uHeartSurface;
  uniform float uHeartFiber;
  uniform vec2 uHeartMeso;
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
    shader.uniforms.uHeartMeso = { value: new THREE.Vector2(profile.mesoScale, profile.mesoStrength) };
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
        // Warped contour bands suggest the small, curved surface lobulation seen in
        // the reference illustration without implying cell-scale histology.
        vec3 heartWarp = vec3(
          heartNoise(heartP * 2.7 + vec3(4.2, 1.1, 7.3)),
          heartNoise(heartP * 2.7 + vec3(8.4, 5.6, 2.2)),
          heartNoise(heartP * 2.7 + vec3(1.7, 9.1, 4.8))
        ) - 0.5;
        vec3 heartMesoP = vec3(
          dot(heartP + heartWarp * 0.16, vec3(0.79, 0.43, 0.44)),
          dot(heartP + heartWarp * 0.16, vec3(-0.52, 0.84, 0.16)),
          dot(heartP + heartWarp * 0.16, vec3(-0.30, -0.36, 0.88))
        );
        float heartMesoField = heartNoise(heartMesoP * uHeartMeso.x)
          + heartNoise((heartMesoP - heartWarp * 0.09) * (uHeartMeso.x * 1.73)
            + vec3(5.7, 2.4, 8.1)) * 0.38;
        float heartMesoDistance = abs(fract(heartMesoField * 2.7) - 0.5);
        float heartMesoWidth = max(fwidth(heartMesoField) * 2.2, 0.018);
        float heartMesoLine = 1.0 - smoothstep(0.055, 0.055 + heartMesoWidth, heartMesoDistance);
        float heartMesoPatch = smoothstep(0.32, 0.76, heartMesoField);
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
        float heartMesoAmount = uHeartMeso.y * uHeartDetail;
        diffuseColor.rgb *= 1.0 - heartMesoLine * heartMesoAmount * 0.085;
        diffuseColor.rgb *= mix(vec3(1.0), vec3(1.035, 0.985, 0.975),
          heartMesoPatch * heartMesoAmount * 0.55);
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (heartMedium - 0.5)
          * uHeartSurface.w * uHeartDetail, 0.20, 0.85);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        #include <normal_fragment_maps>
        float heartHeight = ((heartGrain - 0.5) * 0.70
          + heartFiber * uHeartFiber * 0.12
          - heartMesoLine * uHeartMeso.y * 0.42) * uHeartSurface.y * uHeartDetail;
        normal = heartMicroNormal(normal, heartHeight);
      `);
  }

  override customProgramCacheKey(): string { return 'heart-surface-20260906-v2'; }
}

/** PBR appearance estimates. All anatomical structure remains in the model geometry. */
export function createHeartMaterials(): {
  materials: Record<MaterialId, THREE.MeshPhysicalMaterial>;
  ready: Promise<void>;
} {
  const definitions: Record<MaterialId, {
    color: number; roughness: number; coat: number; coatRoughness: number; profile: SurfaceProfile;
  }> = {
    myocardium: { color: 0xa33b34, roughness: 0.46, coat: 0.18, coatRoughness: 0.32,
      profile: { colorVariation: 0.48, relief: 0.00145, grainScale: 72, roughnessVariation: 0.18,
        fiber: 0.8, mesoScale: 7.2, mesoStrength: 0.85 } },
    atrial: { color: 0xb1534c, roughness: 0.49, coat: 0.19, coatRoughness: 0.33,
      profile: { colorVariation: 0.36, relief: 0.00120, grainScale: 80, roughnessVariation: 0.15,
        fiber: 0.45, mesoScale: 8.4, mesoStrength: 0.82 } },
    arterial: { color: 0xb52a22, roughness: 0.39, coat: 0.24, coatRoughness: 0.30,
      profile: { colorVariation: 0.19, relief: 0.00045, grainScale: 86, roughnessVariation: 0.10,
        fiber: 0.15, mesoScale: 11.0, mesoStrength: 0.16 } },
    venous: { color: 0x28548c, roughness: 0.42, coat: 0.22, coatRoughness: 0.31,
      profile: { colorVariation: 0.21, relief: 0.00038, grainScale: 90, roughnessVariation: 0.10,
        fiber: 0.12, mesoScale: 11.5, mesoStrength: 0.12 } },
    fat: { color: 0xe5b66a, roughness: 0.48, coat: 0.21, coatRoughness: 0.30,
      profile: { colorVariation: 0.15, relief: 0.00085, grainScale: 54, roughnessVariation: 0.10,
        fiber: 0, mesoScale: 9.0, mesoStrength: 0.24 } },
    coronaryRed: { color: 0xaf211d, roughness: 0.33, coat: 0.34, coatRoughness: 0.24,
      profile: { colorVariation: 0.09, relief: 0.00012, grainScale: 90, roughnessVariation: 0.04,
        fiber: 0, mesoScale: 13.0, mesoStrength: 0.05 } },
    coronaryBlue: { color: 0x204a80, roughness: 0.35, coat: 0.32, coatRoughness: 0.25,
      profile: { colorVariation: 0.10, relief: 0.00012, grainScale: 90, roughnessVariation: 0.04,
        fiber: 0, mesoScale: 13.0, mesoStrength: 0.04 } },
  };
  const materials = {} as Record<MaterialId, THREE.MeshPhysicalMaterial>;
  for (const id of Object.keys(definitions) as MaterialId[]) {
    const d = definitions[id];
    const material = new HeartSurfaceMaterial({
      name: id, color: d.color, roughness: d.roughness, metalness: 0,
      clearcoat: d.coat, clearcoatRoughness: d.coatRoughness,
      ior: 1.38, specularIntensity: 0.62, envMapIntensity: 0.55,
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
