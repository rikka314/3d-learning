# Reading Card: DreamFusion: Text-to-3D using 2D Diffusion

## Bibliographic identity
- Title: DreamFusion: Text-to-3D using 2D Diffusion
- Authors: Ben Poole, Ajay Jain, Jonathan T. Barron, Ben Mildenhall
- Venue/year: arXiv, 2022
- DOI/arXiv/OpenReview: arXiv:2209.14988v1
- Code/data/project: https://dreamfusion3d.github.io/
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R08_DreamFusion_基于二维扩散的文本到3D.pdf

## Problem

Large labeled 3D datasets and efficient 3D diffusion models were unavailable, while text-to-image diffusion models already encoded broad visual priors.

## Core idea

Use score distillation sampling (SDS), derived from a pretrained 2D text-to-image diffusion model, to optimize a NeRF so that random-view renders match the text prior.

## Claimed contributions

- Text-to-3D without 3D training data.
- A probability-density-distillation loss usable with a frozen 2D diffusion model.
- A relightable, viewable NeRF rather than a single 2D image.

## Method

Randomly sample camera poses, render the NeRF, add diffusion noise, and backpropagate the SDS gradient to NeRF parameters; density regularization and view-dependent prompting stabilize optimization.

## Experimental setup
- Datasets/simulators/robots: Text prompts and synthetic NeRF optimization; no named training dataset.
- Baselines: The PDF discusses prior text-to-3D/CLIP-based methods; a complete common benchmark is not provided.
- Metrics: Qualitative renders and text-image similarity analyses; exact metric protocol not found.
- Ablations: Guidance/seed and optimization choices are discussed in the appendix.
- Sim-only, real-robot, or mixed: Simulation/rendering only.

## Main evidence
- What the paper directly supports: A frozen 2D diffusion prior can optimize a 3D NeRF from text [Paper Abstract, §§3–4].
- What remains unsupported or weak: It does not establish reliable topology, view consistency for all prompts or production-grade speed.

## Limitations and failure cases

Per-instance optimization is slow; 2D priors can cause Janus/multi-view inconsistencies, missing backsides and oversmoothed geometry.

## What is reusable

The SDS formulation remains a useful baseline for testing whether a new 3D representation can absorb 2D semantic priors.

## What is questionable

Visual plausibility of a few renders is not evidence of complete 3D structure or physical validity.

## Relation to our project

Historical baseline for anatomy-conditioned generation; likely unsuitable for large-scale patient-specific throughput without amortization or stronger geometric supervision.

## Citation notes
- Safe claims this paper can support: SDS-based text-to-3D with no 3D training data (direct).
- Claims this paper should not be used to support: Fast inference, watertight meshes or clinical reconstruction (unsupported).

