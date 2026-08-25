# Reading Card: 4DWorldBench: A Comprehensive Evaluation Framework for 3D/4D World Generation Models

## Bibliographic identity
- Title: 4DWorldBench: A Comprehensive Evaluation Framework for 3D/4D World Generation Models
- Authors: Yiting Lu, Wei Luo, Peiyan Tu, Haoran Li, Hanxin Zhu, Zihao Yu, Xingrui Wang, Xinyi Chen, Xinge Peng, Xin Li, Zhibo Chen
- Venue/year: CVPR, 2026
- DOI/arXiv/OpenReview: CVPR 2026 paper
- Code/data/project: https://yeppp27.github.io/4DWorldBench/
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R41_4DWorldBench_三维四维世界生成评测.pdf

## Problem

Existing video, world-model and physics benchmarks each cover only part of the target: perceptual quality, condition alignment, physical realism or 4D consistency.

## Core idea

Create a multimodal, physics-aware benchmark and select hybrid evaluation tools per dimension: feature metrics plus MLLM/LLM question-answering and human studies.

## Claimed contributions

- Unified evaluation across perceptual quality, condition-4D alignment, physical realism and 4D consistency.
- Text, image and video conditioning support.
- Adaptive dimension selection (AdaDimen) and hybrid QA evaluation.

## Method

Map non-text conditions into textual descriptions when needed, ask dimension-specific questions, combine model-based, feature-based and QA scores, and validate reliability with human studies.

## Experimental setup
- Datasets/simulators/robots: Curated text/image/video samples; physical and non-physical subsets, including Objaverse-XL-derived content and WISA-related physical data.
- Baselines: Video/world generation evaluators and trained VideoPhy-style physical evaluation.
- Metrics: Four main dimensions with model/feature/LLM/MLLM scores; physical QA uses PC, SA and joint scores.
- Ablations: AdaDimen, question richness and hybrid evaluator components.
- Sim-only, real-robot, or mixed: Generated visual worlds; no physical robot experiment.

## Main evidence
- What the paper directly supports: Adaptive/hybrid evaluation gives the reported reliability/performance gains and covers dimensions omitted by earlier benchmarks [Paper Abstract, §§3–5, Conclusion].
- What remains unsupported or weak: Automated physical assessment is indirect and cannot verify actual mechanics.

## Limitations and failure cases

LLM/MLLM judge bias, caption conversion loss, prompt coverage limits and the gap between video physics plausibility and simulated/real physics.

## What is reusable

Use the dimension-separated protocol for 4D anatomy: visual quality, condition alignment, deformation plausibility and temporal correspondence.

## What is questionable

Physics-aware video scoring should not be interpreted as validated biomechanical simulation.

## Relation to our project

A useful evaluation scaffold for temporal organ/scene generation, with medical experts and biomechanical metrics replacing generic physical QA where needed.

## Citation notes
- Safe claims this paper can support: Four evaluation dimensions, hybrid methodology and reported benchmark scope (direct).
- Claims this paper should not be used to support: Clinical or biomechanical validity (unsupported).

