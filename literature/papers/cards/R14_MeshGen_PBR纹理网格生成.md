# Reading Card: MeshGen: Generating PBR Textured Mesh with Render-Enhanced Auto-Encoder and Generative Data Augmentation

## Bibliographic identity
- Title: MeshGen: Generating PBR Textured Mesh with Render-Enhanced Auto-Encoder and Generative Data Augmentation
- Authors: Zilong Chen, Yikai Wang, Wenqiang Sun, Feng Wang, Yiwen Chen, Huaping Liu
- Venue/year: CVPR, 2025
- DOI/arXiv/OpenReview: CVPR 2025 paper; identifier not found in local PDF
- Code/data/project: https://heheyas.github.io/MeshGen
- Original local PDF (complete path): D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R14_MeshGen_PBR纹理网格生成.pdf

## Problem

Native 3D diffusion models have weak mesh autoencoders, limited image controllability and inconsistent texture; view-lifting methods often produce non-PBR appearance.

## Core idea

Use a render-enhanced point-to-shape autoencoder, geometric/generative rendering augmentation, and a reference-attention multi-view ControlNet plus PBR decomposition/UV inpainting.

## Claimed contributions

- Better mesh latent reconstruction through ray-based perceptual regularization.
- Data augmentation for image-shape alignment and generalization.
- Image-to-3D meshes with consistent PBR components and invisible-region completion.

## Method

Encode point/mesh geometry into a compact latent, train generative shape prediction, synthesize multi-view appearance conditioned on the reference, decompose base-color/metallic/roughness-like channels and bake them into UVs.

## Experimental setup
- Datasets/simulators/robots: Public 3D asset data and rendered image conditions; exact split not found.
- Baselines: Native 3D diffusion and multi-view/reconstruction methods.
- Metrics: Shape and texture generation metrics plus qualitative PBR comparisons; exact values not transcribed.
- Ablations: Autoencoder, augmentation and texture modules are ablated.
- Sim-only, real-robot, or mixed: Static assets; no robot experiment.

## Main evidence
- What the paper directly supports: The paper reports improvements in both shape and PBR texture generation over its compared baselines [Paper Abstract, §§3–5].
- What remains unsupported or weak: It does not establish artist-friendly topology or medical generalization.

## Limitations and failure cases

UV seams, unseen regions and mesh extraction remain failure points; PBR decomposition can be ambiguous from images.

## What is reusable

Use render-aware latent losses and explicit material channels when generating anatomy surfaces or modality-linked textures.

## What is questionable

Rendered PBR quality can mask incorrect geometry or lighting assumptions.

## Relation to our project

Relevant to photorealistic anatomical visualization, but not to diagnosis or quantitative reconstruction without medical ground truth.

## Citation notes
- Safe claims this paper can support: Its four main modules and image-to-PBR-mesh objective (direct).
- Claims this paper should not be used to support: Watertightness, physical correctness or clinical realism (unsupported).

