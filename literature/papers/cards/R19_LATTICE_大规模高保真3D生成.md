# Reading Card: LATTICE: Democratize High-Fidelity 3D Generation at Scale

## Bibliographic identity
- Title: LATTICE: Democratize High-Fidelity 3D Generation at Scale
- Authors: Zeqiang Lai, Yunfei Zhao, Zibo Zhao, Haolin Liu, Qingxiang Lin, Jingwei Huang, Chunchao Guo, Xiangyu Yue
- Venue/year: CVPR, 2026
- DOI/arXiv/OpenReview: CVPR 2026 paper; identifier not found in local PDF
- Code/data/project: https://lattice3d.github.io
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R19_LATTICE_大规模高保真3D生成.pdf

## Problem

3D representations either lack spatial structure (VecSet-like tokens) or are too expensive at high resolution, creating a quality/scalability gap with 2D generation.

## Core idea

VoxSet anchors compact latent vectors to a coarse voxel grid; LATTICE first generates sparse geometry anchors and then detailed geometry with a rectified-flow transformer, supporting token-level test-time scaling.

## Claimed contributions

- Semi-structured position-aware VoxSet.
- Arbitrary-resolution decoding and flexible inference.
- Test-time token scaling that improves fidelity beyond training token counts.

## Method

Encode assets into coarse anchors plus local latent vectors, generate anchors and details in two stages, and allocate more tokens at inference when quality is prioritized.

## Experimental setup
- Datasets/simulators/robots: Large-scale 3D asset data; exact split not found.
- Baselines: VecSet and other high-fidelity 3D generators.
- Metrics: Reconstruction/generation quality and token/runtime scaling; exact table values not transcribed.
- Ablations: Token count, anchor structure and resolution.
- Sim-only, real-robot, or mixed: Static assets; no robot experiment.

## Main evidence
- What the paper directly supports: VoxSet improves structured compression and enables resolution/token scaling in the reported experiments [Paper Abstract, Fig. 2].
- What remains unsupported or weak: Test-time scaling increases compute and no medical distribution test is shown.

## Limitations and failure cases

High-resolution token counts and generation cost can still be substantial; structured latents may not preserve arbitrary topology without suitable decoders.

## What is reusable

Budget-aware token scaling could trade anatomy fidelity against interactive latency in clinical visualization.

## What is questionable

High-resolution output is not equivalent to accurate patient-specific detail.

## Relation to our project

Potential backbone for multi-resolution anatomical assets and progressive review workflows.

## Citation notes
- Safe claims this paper can support: VoxSet, two-stage LATTICE and token-level test-time scaling (direct).
- Claims this paper should not be used to support: Clinical reconstruction accuracy or real-time guarantees on other hardware (unsupported).

