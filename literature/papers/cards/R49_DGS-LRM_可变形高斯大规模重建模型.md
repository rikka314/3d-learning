# Reading Card: DGS-LRM: Real-Time Deformable 3D Gaussian Reconstruction From Monocular Videos

## Bibliographic identity
- Title: DGS-LRM: Real-Time Deformable 3D Gaussian Reconstruction From Monocular Videos
- Authors: Chieh Hubert Lin, Zhaoyang Lv, Songyin Wu, Zhen Xu, Thu Nguyen-Phuoc, Hung-Yu Tseng, Julian Straub, Numair Khan, Lei Xiao, Ming-Hsuan Yang, Yuheng Ren, Richard Newcombe, Zhao Dong, Zhengqin Li
- Venue/year: arXiv preprint, 2025
- DOI/arXiv/OpenReview: arXiv:2506.09997v1
- Code/data/project: not found in local PDF
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R49_DGS-LRM_可变形高斯大规模重建模型.pdf

## Problem

Feed-forward reconstruction is mostly static; dynamic monocular reconstruction lacks dense, scalable 3D-motion supervision and a suitable deformable representation.

## Core idea

Predict per-pixel deformable 3D Gaussians and scene flow from a posed monocular video in a single transformer pass, trained with large multi-view synthetic supervision.

## Claimed contributions

- Feed-forward deformable 3DGS with novel-view rendering, geometry and world-space scene flow.
- A customized Kubric multi-view dataset with dense 3D flow.
- Reported 0.6s inference and competitive 3D tracking with flow chaining.

## Method

Render four synchronized Kubric cameras, supervise deformable Gaussian parameters and 3D flow, then use a transformer with temporal tokenization to predict the dynamic representation from one posed video.

## Experimental setup
- Datasets/simulators/robots: Customized Kubric/MOVi-E-style data; evaluation on DyCheck, DAVIS and PointOdyssey.
- Baselines: D3DGS, optimization methods and SpatialTracker/other 3D tracking systems.
- Metrics: Novel-view reconstruction metrics on DyCheck, tracking scores including Flow Valid on PointOdyssey, qualitative DAVIS results.
- Ablations: Data, temporal tokenization, representation and training components.
- Sim-only, real-robot, or mixed: Synthetic training plus real video evaluation; no robot experiment.

## Main evidence
- What the paper directly supports: Its synthetic supervision improves reported real-world reconstruction and gives tracking comparable to SpatialTracker in the named test [Paper §§3–4].
- What remains unsupported or weak: Generalization relies on synthetic physics/motion and posed monocular inputs.

## Limitations and failure cases

The authors state that it cannot handle temporally distant discrete images, struggles with extremely large motion, has synthetic-to-real gaps, and degrades as novel views move away from the input trajectory [Paper §5].

## What is reusable

Dense 3D flow plus deformable-Gaussian representation offers a useful template for dynamic organ tracking.

## What is questionable

Physically grounded synthetic flow does not establish patient-specific tissue mechanics.

## Relation to our project

Strong candidate for real-time 4D reconstruction research, with medical motion simulation and calibration needed before adoption.

## Citation notes
- Safe claims this paper can support: Representation, synthetic-data approach, 0.6s figure and stated limitations (direct).
- Claims this paper should not be used to support: Accurate extreme deformation or clinical biomechanical realism (unsupported).

