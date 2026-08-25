# Reading Card: SpaceControl: Introducing Test-Time Spatial Control to 3D Generative Modeling

## Bibliographic identity
- Title: SpaceControl: Introducing Test-Time Spatial Control to 3D Generative Modeling
- Authors: Elisabetta Fedele, Francis Engelmann, Ian Huang, Or Litany, Marc Pollefeys, Leonidas Guibas
- Venue/year: ICLR, 2026
- DOI/arXiv/OpenReview: arXiv:2512.05343v2; OpenReview venue version
- Code/data/project: https://spacecontrol3d.github.io/
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R23_SpaceControl_3D资产空间控制.pdf

## Problem

Text is ambiguous and images are hard to edit when users need precise geometric control.

## Core idea

A training-free, test-time method feeds coarse primitives (e.g. superquadrics) or meshes into existing 3D generators; a control parameter trades geometric fidelity against realism.

## Claimed contributions

- Spatial control without retraining the base generator.
- Support for coarse-to-detailed geometric sketches and interactive editing.
- Quantitative and user-study gains over training- and optimization-based baselines.

## Method

Convert input geometry into guidance features, inject them during generation/denoising, and tune the control strength at inference.

## Experimental setup
- Datasets/simulators/robots: 3D asset generation benchmarks and an interactive superquadric interface; exact split not found.
- Baselines: Training-based spatial control and test-time optimization methods.
- Metrics: Geometric faithfulness, visual quality and user preference.
- Ablations: Control-strength and input-geometry studies.
- Sim-only, real-robot, or mixed: Static assets; no robot experiment.

## Main evidence
- What the paper directly supports: Better geometric faithfulness while preserving visual quality in its evaluations [Paper Abstract, §§4–5].
- What remains unsupported or weak: Runtime and robustness for noisy medical geometry are not reported.

## Limitations and failure cases

Very coarse or inaccurate sketches can constrain the wrong shape; test-time guidance still incurs inference overhead; outputs remain decoder-dependent.

## What is reusable

Use clinician-editable 3D sketches or organ templates as a control channel without retraining every generator.

## What is questionable

User preference for “faithful” geometry may not match measurement-level anatomical accuracy.

## Relation to our project

Promising interface layer for interactive anatomy correction and surgical planning asset editing.

## Citation notes
- Safe claims this paper can support: Training-free spatial guidance, control tradeoff and reported evaluation trend (direct).
- Claims this paper should not be used to support: No-training clinical robustness or real-time guarantees on arbitrary hardware (unsupported).

