# 论文阅读卡：MeshGen: Generating PBR Textured Mesh with Render-Enhanced Auto-Encoder and Generative Data Augmentation

## 书目信息
- 标题：MeshGen: Generating PBR Textured Mesh with Render-Enhanced Auto-Encoder and Generative Data Augmentation
- 作者：Zilong Chen, Yikai Wang, Wenqiang Sun, Feng Wang, Yiwen Chen, Huaping Liu
- 发表场所/年份：CVPR，2025
- DOI/arXiv/OpenReview：CVPR 2025 论文；本地 PDF 中 identifier not found
- 代码/数据/项目：https://heheyas.github.io/MeshGen
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R14_MeshGen_PBR纹理网格生成.pdf

## 问题

原生 3D diffusion 的 mesh autoencoder 较弱、图像控制有限且纹理不一致；基于多视图提升的方法往往只能输出非 PBR 外观。

## 核心思想

结合渲染增强的 point-to-shape autoencoder、几何/生成式渲染增强、带 reference attention 的多视图 ControlNet，以及 PBR 分解和 UV inpainting。

## 论文声称的贡献

- 通过基于 ray 的感知正则改进 mesh latent 重建。
- 用数据增强改善图像-形状对齐和泛化。
- 输出具有一致 PBR 组成与不可见区域补全的 image-to-3D mesh。

## 方法

将点/mesh 几何编码到紧凑 latent，训练形状生成，参考图像合成多视图外观，分解 base color、metallic、roughness 等通道并 baking 到 UV。

## 实验设置
- 数据集/模拟器/机器人：公共 3D 资产与渲染图像条件；具体划分 not found。
- 基线：原生 3D diffusion、多视图和重建方法。
- 指标：形状/纹理生成指标及 PBR 定性比较；具体数值未抄录。
- 消融实验：autoencoder、增强策略和纹理模块。
- 仅模拟、真实机器人或混合：静态资产，无机器人实验。

## 主要证据
- 论文直接支持的内容：论文报告其方法在所比较基线上同时改进形状和 PBR 纹理生成 [论文摘要，§§3–5]。
- 仍缺乏支持或证据较弱的内容：没有证明 artist-friendly topology 或医学泛化。

## 局限与失败情形

UV seam、不可见区域和 mesh extraction 仍是失败点；仅由图像分解 PBR 存在歧义。

## 可复用内容

生成解剖表面或模态关联纹理时，可采用渲染感知 latent loss 和显式材质通道。

## 值得质疑之处

良好 PBR 渲染可能掩盖错误几何或光照假设。

## 与本项目的关系

适合逼真解剖可视化，但没有医学 ground truth 时不能用于诊断或定量重建。

## 引用说明
- 本文可安全支持的论断：四个主要模块和 image-to-PBR-mesh 目标（直接支持）。
- 不应使用本文支持的论断：watertight、物理正确或临床真实（不支持）。

