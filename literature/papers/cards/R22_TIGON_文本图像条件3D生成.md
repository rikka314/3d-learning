# Reading Card: Text-Image Conditioned 3D Generation (TIGON)

## Bibliographic identity
- Title: Text-Image Conditioned 3D Generation
- Authors: Jiazhong Cen, Jiemin Fang, Sikuang Li, Guanjun Wu, Chen Yang, Taoran Yi, Zanwei Zhou, Zhikuan Bao, Lingxi Xie, Wei Shen, Qi Tian
- Venue/year: CVPR, 2026
- DOI/arXiv/OpenReview: CVPR 2026 paper; identifier not found in local PDF
- Code/data/project: https://jumpat.github.io/tigon-page
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R22_TIGON_文本图像条件3D生成.pdf

## Problem

Image-only conditioning preserves observed appearance but hallucinates occluded regions; text-only conditioning is semantically flexible but lacks precise visual detail.

## Core idea

Use separate image- and text-conditioned backbones with lightweight cross-modal fusion, formalizing joint text-image-conditioned 3D generation.

## Claimed contributions

- A diagnostic study showing complementarity and gains over simple single-modality/late-fusion alternatives.
- A minimalist dual-branch baseline for joint reasoning.
- Text-image-conditioned generation with improved semantic alignment and visual fidelity.

## Method

Encode image and text independently, fuse their features, and predict the 3D asset through the underlying generation/reconstruction pipeline.

## Experimental setup
- Datasets/simulators/robots: 3D asset data with image/text conditions; exact datasets and splits not found.
- Baselines: Image-only, text-only and late-fusion/single-modality models.
- Metrics: Generation quality and condition alignment; exact metric names not transcribed.
- Ablations: Modality and fusion diagnostics.
- Sim-only, real-robot, or mixed: Static assets; no robot experiment.

## Main evidence
- What the paper directly supports: Joint conditioning consistently improves over single-modality methods in the reported experiments [Paper Abstract, §3].
- What remains unsupported or weak: It is a baseline design; broad open-domain and medical generalization are untested.

## Limitations and failure cases

Conflicting or low-information modalities can confuse fusion; unseen geometry remains underconstrained; dual encoders add compute.

## What is reusable

Combine clinical image evidence with textual anatomy/structure constraints rather than forcing either modality to carry all information.

## What is questionable

Improved perceptual alignment does not prove that text resolves hidden anatomical ambiguity correctly.

## Relation to our project

Directly relevant to multimodal patient-specific asset generation, with medical prompts and structured labels replacing generic text.

## Citation notes
- Safe claims this paper can support: The single-modality bottleneck, dual-branch design and reported comparative trend (direct).
- Claims this paper should not be used to support: Correct hidden anatomy or clinical decision quality (unsupported).
