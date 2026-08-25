# Reading Card: Gen3R: 3D Scene Generation Meets Feed-Forward Reconstruction

## Bibliographic identity
- Title: 3D Scene Generation Meets Feed-Forward Reconstruction
- Authors: Jiaxin Huang, Yuanbo Yang, Bangbang Yang, Lin Ma, Yuewen Ma, Yiyi Liao
- Venue/year: CVPR, 2026
- DOI/arXiv/OpenReview: CVPR 2026 paper
- Code/data/project: https://xdimlab.github.io/Gen3R/
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R36_Gen3R_3D场景生成与前馈重建.pdf

## Problem

Video diffusion gives strong appearance priors but weak explicit geometry; reconstruction models give geometry but do not generate rich novel scenes.

## Core idea

Repurpose VGGT tokens as geometric latents, align them through an adapter with video-diffusion appearance latents, and jointly generate RGB video and globally consistent 3D geometry.

## Claimed contributions

- A geometry-aware VAE/adapter bridge between VGGT and video diffusion.
- Joint scene generation, feed-forward reconstruction and camera control.
- Reported improvements over Aether, WVD and other generative/reconstruction baselines.

## Method

Encode geometry with VGGT, align geometry and appearance latent distributions, apply video diffusion with camera conditions, then decode RGB, depth/camera and global point clouds.

## Experimental setup
- Datasets/simulators/robots: Over 300K calibrated multi-view training data; evaluation on RealEstate10K, DL3DV-10K, Co3Dv2, WildRGB-D and TartanAir.
- Baselines: Gen3C, Geometry Forcing, Aether, WVD and VGGT-style reconstruction.
- Metrics: PSNR/SSIM/LPIPS-like appearance metrics; accuracy, completeness and Chamfer distance for geometry; AUC@30 for camera control.
- Ablations: Geometry adapter/alignment and two-stage alternatives.
- Sim-only, real-robot, or mixed: Mixed real/synthetic vision datasets; no robot hardware.

## Main evidence
- What the paper directly supports: Joint geometry/appearance modeling improves reported generation and reconstruction metrics over the compared baselines [Paper §§4–5, Tables 1–5].
- What remains unsupported or weak: Video/geometry gains are benchmark-specific and do not prove long-term physical consistency.

## Limitations and failure cases

Geometry depends on VGGT accuracy; diffusion can hallucinate under occlusion; memory/latency and dynamic-scene coverage remain constraints.

## What is reusable

The geometry-token plus video-prior bridge is a compelling blueprint for 3D/4D medical scene synthesis.

## What is questionable

Point-cloud consistency can coexist with anatomically wrong content if training data lack medical semantics.

## Relation to our project

Potential architecture for combining patient scans/poses with generative completion and view synthesis.

## Citation notes
- Safe claims this paper can support: VGGT-video latent bridge, datasets, metrics and reported baseline comparisons (direct).
- Claims this paper should not be used to support: Clinical image fidelity or physical world consistency outside tested benchmarks (unsupported).

