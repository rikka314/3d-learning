# Reading Card: VGGT: Visual Geometry Grounded Transformer

## Bibliographic identity
- Title: VGGT: Visual Geometry Grounded Transformer
- Authors: Jianyuan Wang, Minghao Chen, Nikita Karaev, Andrea Vedaldi, Christian Rupprecht, David Novotny
- Venue/year: CVPR, 2025
- DOI/arXiv/OpenReview: arXiv:2503.11651
- Code/data/project: not found in local PDF
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R29_VGGT_视觉几何基础模型.pdf

## Problem

Classical multi-view reconstruction relies on iterative optimization and separate models for cameras, depth, point maps and tracking.

## Core idea

A large feed-forward transformer predicts cameras, point maps, depth maps and point tracks jointly from one to hundreds of images, with minimal explicit 3D inductive bias.

## Claimed contributions

- Unified geometry foundation model.
- Inference in under one second for the advertised input regime.
- Competitive/state-of-the-art results across camera, depth, point-cloud and tracking tasks.

## Method

Encode image tokens with global and local interactions, then decode task tokens and per-image geometry outputs in one forward pass.

## Experimental setup
- Datasets/simulators/robots: Multiple 3D-annotated datasets; exact training mix not fully enumerated in the card source.
- Baselines: Bundle Adjustment/optimization pipelines and learned geometry models.
- Metrics: Camera pose, depth, point-cloud reconstruction and 3D tracking metrics.
- Ablations: Input count, model size and local/detail tokens.
- Sim-only, real-robot, or mixed: Public synthetic and real-image benchmarks; no robot deployment.

## Main evidence
- What the paper directly supports: Joint feed-forward geometry predictions can outperform optimization-based alternatives without post-processing on several benchmarks [Paper Abstract, §4, Conclusion].
- What remains unsupported or weak: Performance depends on training distribution, camera conventions and scene coverage.

## Limitations and failure cases

Unseen domains, severe occlusion, dynamic scenes and metric-scale ambiguity remain difficult; generated point maps are not meshes by themselves.

## What is reusable

Use VGGT as a geometry encoder, camera estimator or consistency module before/inside a generative anatomy pipeline.

## What is questionable

Fast inference does not remove the need for medical calibration, uncertainty estimation or registration validation.

## Relation to our project

High-value foundation for patient-specific multi-view/video reconstruction and for supervising generative models with explicit geometry.

## Citation notes
- Safe claims this paper can support: Joint outputs, feed-forward design and benchmark task scope (direct).
- Claims this paper should not be used to support: Clinical reconstruction accuracy or dynamic anatomy without additional validation (unsupported).

