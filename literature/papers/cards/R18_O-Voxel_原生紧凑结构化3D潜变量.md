# Reading Card: Native and Compact Structured Latents for 3D Generation

## Bibliographic identity
- Title: Native and Compact Structured Latents for 3D Generation
- Authors: Jianfeng Xiang, Xiaoxue Chen, Sicheng Xu, Ruicheng Wang, Zelong Lv, Yu Deng, Hongyuan Zhu, Yue Dong, Hao Zhao, Nicholas Jing Yuan, Jiaolong Yang
- Venue/year: CVPR, 2026
- DOI/arXiv/OpenReview: CVPR 2026 paper; identifier not found in local PDF
- Code/data/project: Open-source project; exact URL not found in local PDF
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R18_O-Voxel_原生紧凑结构化3D潜变量.pdf

## Problem

Iso-surface representations struggle with open/non-manifold/enclosed structures and often omit appearance/material information; large 3D models also need compact latents.

## Core idea

O-Voxel is a field-free sparse voxel representation encoding geometry and PBR attributes; Sparse Compression VAE compresses native assets, then a ~4B flow-matching generator operates in that latent.

## Claimed contributions

- Arbitrary-topology geometry, including open, non-manifold and enclosed surfaces.
- Joint geometry and PBR/material representation.
- Reported generation times of about 3s (512³), 17s (1024³), 60s (1536³) on H100.

## Method

Project native mesh surfaces and attributes into active voxels, learn sparse compression/reconstruction, and generate latent tokens with image-conditioned flow matching.

## Experimental setup
- Datasets/simulators/robots: Diverse public 3D asset datasets; exact composition/split not found.
- Baselines: TRELLIS, Dora, SparseFlex and Direct3D-S2 are shown in representation comparisons.
- Metrics: Mesh distance, normal PSNR and material-channel reconstruction/quality; generation speed.
- Ablations: Compression/token-count and latent design studies.
- Sim-only, real-robot, or mixed: Static asset generation; no robot experiment.

## Main evidence
- What the paper directly supports: Strong reconstruction compactness and high-resolution textured generation in its reported benchmarks [Paper Fig. 1, Abstract, experiments].
- What remains unsupported or weak: No medical or physical-simulation validation.

## Limitations and failure cases

Large memory/training cost, dependence on curated native assets and uncertain behavior on thin anatomy or noisy scans.

## What is reusable

Field-free structured latents are promising for preserving anatomical cavities, open surfaces and material/label channels.

## What is questionable

Visual PBR metrics do not guarantee semantic correspondence of internal anatomical structures.

## Relation to our project

High-potential representation for topology-aware anatomy generation, especially when internal surfaces and material maps matter.

## Citation notes
- Safe claims this paper can support: O-Voxel design, topology scope, model scale and reported runtimes (direct).
- Claims this paper should not be used to support: Clinical anatomy fidelity or noise robustness (unsupported).

