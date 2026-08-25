# Reading Card: PartGen: Part-level 3D Generation and Reconstruction with Multi-View Diffusion Models

## Bibliographic identity
- Title: Part-level 3D Generation and Reconstruction with Multi-View Diffusion Models
- Authors: Minghao Chen, Roman Shapovalov, Iro Laina, Tom Monnier, Jianyuan Wang, David Novotny, Andrea Vedaldi
- Venue/year: CVPR, 2025
- DOI/arXiv/OpenReview: CVPR 2025 paper; identifier not found in local PDF
- Code/data/project: https://silent-chen.github.io/PartGen
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R15_PartGen_部件级3D生成与重建.pdf

## Problem

Text/image generators and scanners produce fused 3D entities, whereas editing, reuse and animation require semantically meaningful independent parts.

## Core idea

A multi-view diffusion model samples view-consistent part segmentations; a second model completes each part under whole-object context before deterministic 3D reconstruction.

## Claimed contributions

- Text-, image- and unstructured-3D-to-part-composed generation.
- Occlusion-aware part completion.
- Text-guided part editing demonstrations.

## Method

Generate multiple color-coded segmentation hypotheses, aggregate them across views, complete partially/fully hidden parts using contextual diffusion, reconstruct parts, then compose the coherent object.

## Experimental setup
- Datasets/simulators/robots: Artist-created and scanned 3D assets; exact benchmark names/splits not found.
- Baselines: Segmentation and part-completion baselines.
- Metrics: Part segmentation/completion quality and qualitative editing; exact metric values not transcribed.
- Ablations: Sampling and contextual completion components are evaluated.
- Sim-only, real-robot, or mixed: Static assets; no robot experiment.

## Main evidence
- What the paper directly supports: PartGen improves over the compared segmentation/completion baselines and supports part editing [Paper Abstract, §§3–5].
- What remains unsupported or weak: Completion may hallucinate invisible anatomy and evaluation is not clinical.

## Limitations and failure cases

Part semantics are artist-dependent; invisible parts are inherently ambiguous; independent reconstruction can still introduce seams or incorrect interfaces.

## What is reusable

The contextual part-completion idea maps well to organs, instruments and surgical assemblies with occluded structures.

## What is questionable

“Meaningful part” labels from entertainment assets do not automatically correspond to anatomical ontologies.

## Relation to our project

Candidate architecture for editable anatomical components, provided labels and completion targets are medically annotated.

## Citation notes
- Safe claims this paper can support: Multi-view segmentation/completion pipeline and supported input modes (direct).
- Claims this paper should not be used to support: Correctness of hallucinated hidden anatomy (unsupported).

