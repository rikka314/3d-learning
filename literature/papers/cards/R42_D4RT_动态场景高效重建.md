# Reading Card: Efficiently Reconstructing Dynamic Scenes One D4RT at a Time

## Bibliographic identity
- Title: Efficiently Reconstructing Dynamic Scenes One D4RT at a Time
- Authors: Chuhan Zhang, Guillaume Le Moing, Skanda Koppula, Ignacio Rocco, Liliane Momeni, Junyu Xie, Shuyang Sun, Rahul Sukthankar, Joëlle K. Barral, Raia Hadsell, Zoubin Ghahramani, Andrew Zisserman, Junlin Zhang, Mehdi S. M. Sajjadi
- Venue/year: CVPR, 2026
- DOI/arXiv/OpenReview: not found in local PDF
- Code/data/project: https://d4rt-paper.github.io/
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R42_D4RT_动态场景高效重建.pdf

## Problem

Dynamic reconstruction pipelines use distinct dense decoders and test-time optimization for depth, correspondences and cameras, making 4D output costly and fragmented.

## Core idea

Encode a video once into a global scene representation, then answer independent queries for any source pixel, target time and camera coordinate.

## Claimed contributions

- Unified depth, point map, correspondence, tracking and camera prediction.
- Query decoder with inference scaling linearly with the number of requested points.
- Reported 9x speed over VGGT and 100x over optimization alternatives in its capability comparison.

## Method

A transformer video encoder produces global tokens; a query decoder consumes source/target time, image location and camera reference to return 3D positions, while camera parameters are predicted through the same representation.

## Experimental setup
- Datasets/simulators/robots: Kubric, MVS-Synth, PointOdyssey, ScanNet, Waymo Open and internal data for training; Sintel, ScanNet and other benchmarks for evaluation.
- Baselines: VGGT, MegaSaM, tracking/depth/camera systems and optimization-based alternatives.
- Metrics: 3D tracking APD/L1-like scores, depth metrics (including sRel), point-cloud metrics and camera pose RPE.
- Ablations: Local RGB patches, confidence, position embeddings, encoder size and pretrained encoder choices.
- Sim-only, real-robot, or mixed: Synthetic and real vision benchmarks; no robot experiment.

## Main evidence
- What the paper directly supports: The query decoder is efficient and achieves reported top-tier/SOTA results across several dynamic 4D tasks [Paper Abstract, §§4–5].
- What remains unsupported or weak: Results rely on the paper's data mixture and do not validate highly deformable medical anatomy.

## Limitations and failure cases

Query quality depends on video coverage; camera distortion and extreme occlusion remain difficult; the representation is not an explicit watertight mesh.

## What is reusable

The decoupled encode-once/query-anatomy-at-time interface is highly reusable for 4D imaging and motion tracking.

## What is questionable

Multi-task benchmark leadership cannot be converted into a blanket claim of metric-scale, clinical-grade reconstruction.

## Relation to our project

One of the strongest candidates for a 4D patient reconstruction backbone, pending modality-specific training and registration validation.

## Citation notes
- Safe claims this paper can support: Unified query interface, datasets, task/metric coverage and reported speed comparison (direct).
- Claims this paper should not be used to support: Clinical dynamic reconstruction accuracy or mesh topology quality (unsupported).

