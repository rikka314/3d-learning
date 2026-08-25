# Reading Card: Structured 3D Latents for Scalable and Versatile 3D Generation (TRELLIS)

## Bibliographic identity
- Title: Structured 3D Latents for Scalable and Versatile 3D Generation
- Authors: Jianfeng Xiang, Zelong Lv, Sicheng Xu, Yu Deng, Ruicheng Wang, Bowen Zhang, Dong Chen, Xin Tong, Jiaolong Yang
- Venue/year: CVPR, 2025
- DOI/arXiv/OpenReview: CVPR 2025 paper; arXiv identifier not found in the local PDF
- Code/data/project: https://trellis3d.github.io/
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R10_TRELLIS_结构化3D潜变量生成.pdf

## Problem

Existing 3D generators are tied to one representation: fields/3DGS render well but are hard to extract, while meshes are editable but difficult to model with detailed appearance.

## Core idea

Structured LATent (SLAT) combines a sparse 3D grid with dense multi-view visual features, allowing one latent to decode to radiance fields, 3D Gaussians or meshes.

## Claimed contributions

- A unified, structured latent with format-specific decoders.
- Rectified-flow transformers up to 2B parameters trained on about 500K assets.
- Text/image conditioning and tuning-free local editing.

## Method

Encode active sparse voxels plus local visual features; generate sparse structure first, then non-empty-cell latents; decode into the requested representation.

## Experimental setup
- Datasets/simulators/robots: Large collected 3D asset dataset (~500K); exact split not found.
- Baselines: Recent 3D generation models at similar scales.
- Metrics: Shape/appearance quality comparisons; exact metric names and values should be read from the result tables.
- Ablations: Latent resolution/channel and decoder choices are analyzed.
- Sim-only, real-robot, or mixed: Static object generation; no robot experiment.

## Main evidence
- What the paper directly supports: SLAT enables multiple output formats and competitive quality with text/image prompts [Paper Abstract, §§3–5].
- What remains unsupported or weak: Decoder quality and multi-view feature quality can dominate results; no clinical or physical validation is shown.

## Limitations and failure cases

Sparse latent training and renderer-dependent supervision may miss hidden structures or complex topology; mesh usability still depends on post-processing.

## What is reusable

The shared-latent/multi-decoder design is a strong template for geometry plus material plus downstream anatomical representations.

## What is questionable

Cross-format “versatility” does not mean identical fidelity or editability in every decoder.

## Relation to our project

Potential backbone for patient-specific meshes, Gaussian visualization and volumetric decoders sharing one anatomy latent.

## Citation notes
- Safe claims this paper can support: SLAT design, output formats, model scale and editing capability (direct).
- Claims this paper should not be used to support: Clinical reconstruction accuracy or topology guarantees (unsupported).

