# Reading Card: DreamCS: Geometry-Aware Text-to-3D Generation with Unpaired 3D Reward Supervision

## Bibliographic identity
- Title: Geometry-Aware Text-to-3D Generation with Unpaired 3D Reward Supervision
- Authors: Xiandong Zou, Ruihao Xia, Hongsong Wang, Pan Zhou
- Venue/year: ICLR, 2026
- DOI/arXiv/OpenReview: arXiv:2506.09814v3; OpenReview forum PoU33ZdtCP
- Code/data/project: not found in local PDF
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R24_DreamCS_3D偏好对齐生成.pdf

## Problem

2D preference rewards can favor view-dependent plausibility and overlook Janus faces, incomplete geometry and other global 3D defects.

## Core idea

Create unpaired 3D-MeshPref data, train a geometry-aware RewardCS with a Cauchy-Schwarz divergence objective, and feed it into implicit and explicit text-to-3D pipelines.

## Claimed contributions

- Large-scale unpaired 3D preference data labeled by an LLM and refined by humans.
- A 3D reward model that does not require paired comparisons.
- Preference-guided DreamCS generation with improved geometry and human preference.

## Method

Score individual meshes in 3D, optimize generation against the learned reward, and combine the reward with existing text-to-3D objectives.

## Experimental setup
- Datasets/simulators/robots: 3D-MeshPref and text-to-3D generation benchmarks; exact size/split not found.
- Baselines: 2D reward-guided and prior text-to-3D methods.
- Metrics: Human preference, geometry/quality scores and qualitative artifact analysis.
- Ablations: Reward objective and integration into implicit/explicit generators.
- Sim-only, real-robot, or mixed: Static assets; no robot experiment.

## Main evidence
- What the paper directly supports: RewardCS reduces the reported 2D-reward artifacts and improves preference/geometry metrics [Paper Abstract, Fig. 1, experiments].
- What remains unsupported or weak: Reward quality depends on annotation and evaluator distribution; no clinical semantics are tested.

## Limitations and failure cases

Unpaired labels may encode noisy or inconsistent preferences; reward hacking and out-of-distribution meshes remain risks.

## What is reusable

Learn a geometry-level reward for anatomy that combines human preference with explicit surface/topology checks.

## What is questionable

Human preference is not a substitute for expert anatomical correctness or safety constraints.

## Relation to our project

Useful for aligning generated assets to clinician preferences after hard geometric validity gates are in place.

## Citation notes
- Safe claims this paper can support: 3D-MeshPref, RewardCS objective and DreamCS integration (direct).
- Claims this paper should not be used to support: Clinical acceptability or guaranteed elimination of geometric artifacts (unsupported).

