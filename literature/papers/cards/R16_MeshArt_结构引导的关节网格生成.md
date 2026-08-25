# Reading Card: MeshArt: Generating Articulated Meshes with Structure-Guided Transformers

## Bibliographic identity
- Title: MeshArt: Generating Articulated Meshes with Structure-Guided Transformers
- Authors: Daoyi Gao, Yawar Siddiqui, Lei Li, Angela Dai
- Venue/year: CVPR, 2025
- DOI/arXiv/OpenReview: CVPR 2025 paper; identifier not found in local PDF
- Code/data/project: not found in local PDF
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R16_MeshArt_结构引导的关节网格生成.pdf

## Problem

Articulated assets need compact geometry and functional joints, but existing 3D generators mostly create static, fused shapes.

## Core idea

Generate articulation-aware part bounding primitives first, then generate each part's triangle sequence conditioned on structure and local connectivity.

## Claimed contributions

- Hierarchical transformer for articulated mesh generation.
- Structure-guided conditioning for smooth part transitions.
- PartNet augmentation with joint annotations for three categories, increasing articulated data by over 6×.

## Method

Autoregressively quantize and generate structure tokens (part semantics, boxes, articulation modes), then synthesize mesh triangles for each part while propagating neighboring connectivity.

## Experimental setup
- Datasets/simulators/robots: Enhanced PartNet; table, chair and storage categories.
- Baselines: Mesh and articulated-object generation baselines.
- Metrics: Structure coverage and mesh-generation FID; paper reports +57.1% structure coverage and +209 FID points over the comparison.
- Ablations: Structure guidance and connectivity conditioning.
- Sim-only, real-robot, or mixed: Static articulated mesh datasets; no physical robot test.

## Main evidence
- What the paper directly supports: Better structure coverage and mesh FID on its articulated benchmark [Paper Abstract, §4].
- What remains unsupported or weak: The category scope is narrow and does not prove physical joint validity.

## Limitations and failure cases

Sparse joint annotations, autoregressive error accumulation, limited categories and possible mesh-interface artifacts.

## What is reusable

Separate anatomical hierarchy/joints from local surface generation; use explicit connectivity and joint constraints.

## What is questionable

Mesh FID is not a substitute for range-of-motion, collision or biomechanical validation.

## Relation to our project

Relevant for articulated anatomy, surgical tools and organ-motion proxies after replacing PartNet labels with clinical kinematic annotations.

## Citation notes
- Safe claims this paper can support: Hierarchical design, dataset augmentation and reported benchmark deltas (direct).
- Claims this paper should not be used to support: Real-world articulation or clinical biomechanics (unsupported).

