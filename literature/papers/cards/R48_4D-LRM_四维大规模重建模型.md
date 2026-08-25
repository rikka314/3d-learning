# Reading Card: 4D-LRM: Large Space-Time Reconstruction Model From and To Any View at Any Time

## Bibliographic identity
- Title: 4D-LRM: Large Space-Time Reconstruction Model From and To Any View at Any Time
- Authors: Ziqiao Ma, Xuweiyi Chen, Shoubin Yu, Sai Bi, Kai Zhang, Ziwen Chen, Sihan Xu, Jianing Yang, Zexiang Xu, Kalyan Sunkavalli, Mohit Bansal, Joyce Chai, Hao Tan
- Venue/year: arXiv preprint, 2025
- DOI/arXiv/OpenReview: arXiv:2506.18890v1
- Code/data/project: https://4dlrm.github.io/
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R48_4D-LRM_四维大规模重建模型.pdf

## Problem

Prior 4D systems trade off efficiency, generalization and faithfulness, especially for sparse posed observations across time.

## Core idea

Directly predict per-pixel 4D Gaussian primitives from posed image tokens over time, learning a unified spatiotemporal representation that renders arbitrary view-time pairs.

## Claimed contributions

- Large-scale 4D reconstruction from unconstrained view/timestamp inputs.
- One-pass 24-frame sequence reconstruction in under 1.5 seconds on an A100.
- Generalization across views/times and an application to 4D asset generation.

## Method

Transform posed images and timestamps into spatiotemporal tokens, predict Gaussian primitives, then render novel views at arbitrary times.

## Experimental setup
- Datasets/simulators/robots: Objaverse-derived 32K animated objects, 783K static objects as static sequences; Consistent4D and Objaverse4D test data; GSO evaluation.
- Baselines: Multi-view diffusion models, GS-LRM and 4D generation approaches.
- Metrics: PSNR, SSIM and LPIPS averaged across canonical/random render views.
- Ablations: Camera setup, input views, model components and 4D generation settings.
- Sim-only, real-robot, or mixed: Rendered synthetic/asset data; no robot experiment.

## Main evidence
- What the paper directly supports: Better reported rendering metrics across the stated 4D tests and fast 24-frame inference [Paper Abstract, §5, Tables 1–4].
- What remains unsupported or weak: Real-world generalization is limited by mostly asset/rendered training data.

## Limitations and failure cases

The authors note limited input context, 256² training resolution, expensive high-resolution fine-tuning, short sequence duration and occlusion/long-range-dependency issues [Paper §6].

## What is reusable

Use the explicit 4D Gaussian interface for rapid novel view-time rendering from time-stamped clinical observations.

## What is questionable

PSNR/SSIM/LPIPS of renderings do not validate geometric topology or physiological motion.

## Relation to our project

Directly relevant to 4D organ reconstruction, but requires data that capture patient deformation rather than animated object motion.

## Citation notes
- Safe claims this paper can support: Architecture, data scale, metrics and under-1.5s reported 24-frame result (direct).
- Claims this paper should not be used to support: Robust patient-specific reconstruction or high-resolution clinical imaging (unsupported).

