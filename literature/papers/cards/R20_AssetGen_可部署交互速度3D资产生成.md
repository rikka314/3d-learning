# Reading Card: AssetGen: Deployable 3D Asset Generation at Interactive Speed

## Bibliographic identity
- Title: AssetGen: Deployable 3D Asset Generation at Interactive Speed
- Authors: Dilin Wang, Xiaoyu Xiang, Kihyuk Sohn, Tom Monnier, Yu-Ying Yeh, Thu Nguyen-Phuoc, Jiawen Zhang, Yuchen Fan, Antoine Toisoul, Hyunyoung Jung, Prithviraj Dhar, Michael Bunnell, Nikolaos Sarafianos, Chuhang Zou, Roman Shapovalov, Andrea Vedaldi, Rakesh Ranjan
- Venue/year: arXiv preprint, 2026
- DOI/arXiv/OpenReview: arXiv:2605.26137v1
- Code/data/project: not found in local PDF
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R20_AssetGen_可部署交互速度3D资产生成.pdf

## Problem

Research systems often optimize resolution while ignoring end-to-end latency, UVs, normals, polygon budgets and deployment constraints.

## Core idea

Co-design a coarse-to-refine VecSet mesh generator with GPU simplification/cleaning, UV unwrapping, normal baking, multi-view texture generation, backprojection, inpainting, distillation and pipeline parallelism.

## Claimed contributions

- Reference-image-to-mesh with baked normals, color texture and controlled polygon budget in about 30s.
- AssetGen Flash preview in about 14s.
- Automated and blind human evaluations on AssetBench and CharacterBench.

## Method

Generate geometry, simplify/clean it on GPU, unwrap UVs, synthesize multi-view textures, backproject/blend them into the atlas, then inpaint unobserved regions and serialize the runtime asset.

## Experimental setup
- Datasets/simulators/robots: AssetBench and CharacterBench; H100 deployment measurements.
- Baselines: Leading commercial solutions and prior generators.
- Metrics: Visual quality, usability/asset metrics, latency and human preference; exact values not transcribed.
- Ablations: Kernel/precision, distillation, pipeline and post-processing components.
- Sim-only, real-robot, or mixed: Static asset generation; no robot hardware.

## Main evidence
- What the paper directly supports: A full asset pipeline can deliver competitive visual quality at interactive latency [Paper Abstract, §§6–9].
- What remains unsupported or weak: The authors explicitly note marching-cubes/topology limitations and do not show clinical data.

## Limitations and failure cases

Artist-friendly topology, rigging and deformation are not guaranteed; backprojection and inpainting can fail on occlusions and thin structures; domain gap remains.

## What is reusable

Treat post-processing, latency and artifact serialization as first-class model outputs, not afterthoughts.

## What is questionable

“Deployable” is tied to the target engine and hardware; 30s on H100 is not a universal interactive guarantee.

## Relation to our project

Strong systems baseline for a production-oriented anatomy asset pipeline, after adding segmentation, topology and uncertainty audits.

## Citation notes
- Safe claims this paper can support: Pipeline components, 30s/14s reported latency and named evaluations (direct).
- Claims this paper should not be used to support: Artist-quality topology, clinical deployment or biomechanical validity (unsupported).

