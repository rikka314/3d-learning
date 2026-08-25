# Reading Card: Hunyuan3D 2.0: Scaling Diffusion Models for High Resolution Textured 3D Assets Generation

## Bibliographic identity
- Title: Hunyuan3D 2.0: Scaling Diffusion Models for High Resolution Textured 3D Assets Generation
- Authors: Hunyuan3D team
- Venue/year: arXiv, 2025 (local PDF v5 dated 2026)
- DOI/arXiv/OpenReview: arXiv:2501.12202v5
- Code/data/project: https://github.com/Tencent/Hunyuan3D-2
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R11_Hunyuan3D_2.0.pdf

## Problem

High-resolution 3D assets require both geometry and physically useful textures, but jointly learning them is difficult and open-source foundation models were scarce.

## Core idea

Decouple generation into Hunyuan3D-DiT for shape and Hunyuan3D-Paint for texture, with ShapeVAE, flow matching and mesh-conditioned multi-view texture synthesis; package the workflow in Hunyuan3D-Studio.

## Claimed contributions

- Large-scale open shape and texture foundation components.
- High-resolution textured meshes from condition images.
- A user-facing studio supporting manipulation and animation.

## Method

Image-conditioned shape latent generation, followed by multi-view texture rendering, PBR-like baking and completion; the same texture stage can process generated or hand-made meshes.

## Experimental setup
- Datasets/simulators/robots: Large 3D asset collections; exact dataset composition and split not found in the card source.
- Baselines: Open-source models, three commercial closed-source products, TRELLIS and separate shape/texture systems.
- Metrics: Geometry, condition alignment, texture quality and user-study comparisons; exact values not transcribed here.
- Ablations: ShapeVAE, diffusion and texture-pipeline components are analyzed in the paper.
- Sim-only, real-robot, or mixed: Static asset generation; no robot experiment.

## Main evidence
- What the paper directly supports: The two-stage system and reported comparisons across bare mesh, textured mesh and texture-map quality [Paper Abstract, §§2–5].
- What remains unsupported or weak: Commercial comparisons and user studies depend on undisclosed implementation and rendering choices.

## Limitations and failure cases

Decoupling can leave geometry-texture inconsistencies; topology, UV and animation readiness still require downstream checks; no medical evaluation is provided.

## What is reusable

The shape/texture separation and open weights are a practical starting point for anatomy surface generation with controllable texture or modality overlays.

## What is questionable

High-resolution appearance scores do not establish correct hidden anatomy, watertightness or physical simulation behavior.

## Relation to our project

Useful production baseline for visual anatomical assets, but clinical use requires replacing generic object data with validated medical data and adding uncertainty reporting.

## Citation notes
- Safe claims this paper can support: Two-stage Hunyuan3D-DiT/Paint architecture and released code/weights (direct).
- Claims this paper should not be used to support: Clinical realism, surgical safety or universal superiority over closed systems (unsupported/conditional).

