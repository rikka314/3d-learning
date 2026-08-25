# Reading Card: AniGen: Unified S3 Fields for Animatable 3D Asset Generation

## Bibliographic identity
- Title: AniGen: Unified S3 Fields for Animatable 3D Asset Generation
- Authors: Yi-Hua Huang, Zi-Xin Zou, Yuting He, Chirui Chang, Cheng-Feng Pu, Ziyi Yang, Yuan-Chen Guo, Yan-Pei Cao, Xiaojuan Qi
- Venue/year: arXiv preprint, 2026
- DOI/arXiv/OpenReview: arXiv:2604.08746v2
- Code/data/project: not found in local PDF
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R28_AniGen_动画3D生成.pdf

## Problem

Image-to-3D models usually produce static shapes; post-hoc auto-rigging often yields skeletons and skin weights inconsistent with the generated geometry.

## Core idea

Represent Shape, Skeleton and Skin as mutually consistent S3 fields over one spatial domain, with a confidence-decaying skeleton field and dual skin feature field.

## Claimed contributions

- Single-image generation of geometry, skeleton and skinning weights.
- Joint modeling across animals, humans, cartoon and articulated man-made objects.
- A unified alternative to generate-then-rig pipelines.

## Method

Predict shared spatial fields, resolve ambiguous bone boundaries with confidence decay, and infer skinning from dual features tied to the same geometry.

## Experimental setup
- Datasets/simulators/robots: Animatable 3D asset data; exact datasets/splits not found.
- Baselines: Static image-to-3D plus post-hoc rigging and rig-aware methods.
- Metrics: Shape, skeleton and skinning quality; exact names/values not transcribed.
- Ablations: Confidence modeling and dual skin fields.
- Sim-only, real-robot, or mixed: Digital assets; no physical robot test.

## Main evidence
- What the paper directly supports: Joint S3 fields improve consistency in the reported animatable-asset experiments [Paper Abstract, Conclusion].
- What remains unsupported or weak: Category coverage and generalization to medical motion are unknown.

## Limitations and failure cases

Skeleton ambiguity at joints, category-dependent rigs, skin-weight artifacts and limited evidence for long-horizon deformation or collision.

## What is reusable

Couple anatomy surface, landmark/skeleton and deformation weights in one shared latent/field rather than post-processing them independently.

## What is questionable

Animation readiness does not imply biomechanical or physiologic validity.

## Relation to our project

Relevant for deformable organs, musculoskeletal models and surgical-tool articulation once domain-specific kinematic supervision is available.

## Citation notes
- Safe claims this paper can support: S3-field formulation and single-image animatable asset goal (direct).
- Claims this paper should not be used to support: Patient-specific motion or biomechanical accuracy (unsupported).

