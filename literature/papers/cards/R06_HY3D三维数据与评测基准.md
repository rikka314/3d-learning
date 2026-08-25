# Reading Card: HY3D-Bench: Generation of 3D Assets

## Bibliographic identity
- Title: HY3D-Bench: Generation of 3D Assets
- Authors: Tencent Hunyuan3D team (the PDF lists contributors alphabetically at the end)
- Venue/year: arXiv preprint, 2026
- DOI/arXiv/OpenReview: arXiv:2602.03907v1
- Code/data/project: https://github.com/Tencent-Hunyuan/HY3D-Bench; https://huggingface.co/datasets/tencent/HY3D-Bench
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R06_HY3D三维数据与评测基准.pdf

## Problem

Raw web 3D collections contain non-watertight geometry, inconsistent scale/orientation, poor renders and weak part annotations, making training and comparison unstable.

## Core idea

Provide a processed ecosystem: high-fidelity watertight objects and renders, part-level decomposition, a fixed 400-object benchmark, and synthetic long-tail assets.

## Claimed contributions

- 252,000 training-ready objects after curation.
- 240,524 part-level samples and 125,000 AIGC-synthesized long-tail assets.
- Standardized metrics, baselines and configurations, validated with Hunyuan3D-2.1-Small.

## Method

Filtering and normalization of Objaverse/Objaverse-XL, watertight conversion, multi-view rendering, part decomposition, synthetic text/image-to-3D augmentation and benchmark packaging.

## Experimental setup
- Datasets/simulators/robots: Objaverse and Objaverse-XL derived data; 19 top-level categories; 400 held-out test objects.
- Baselines: Hunyuan3D-2.1-Small and cited 3D generation baselines.
- Metrics: Standard geometry/generation metrics defined by the benchmark; exact names and implementation should be read from the benchmark release.
- Ablations: Data-component validation through downstream training comparisons.
- Sim-only, real-robot, or mixed: Static 3D assets; no robot hardware study.

## Main evidence
- What the paper directly supports: The released processing pipeline and downstream utility of the curated data [Paper §§3–6, Conclusion].
- What remains unsupported or weak: Gains are demonstrated on the authors' model and benchmark; transfer to medical distributions is not tested.

## Limitations and failure cases

The release is mostly static and object-centric; synthetic assets may introduce domain gaps; automatic watertightness and part labels can still contain errors.

## What is reusable

Reuse the data contract: canonical orientation, watertight checks, multi-view renders, part graphs and fixed test splits before training an anatomical generator.

## What is questionable

“High fidelity” is a curation criterion, not a guarantee of anatomical realism or suitability for simulation/clinical use.

## Relation to our project

Its preprocessing and benchmark packaging are directly transferable to CT/MRI-derived surface datasets, after adding modality-specific segmentation and registration checks.

## Citation notes
- Safe claims this paper can support: Dataset scale, components and the 400-object benchmark (direct).
- Claims this paper should not be used to support: Medical data quality, clinical generalization or real-robot performance (unsupported).

