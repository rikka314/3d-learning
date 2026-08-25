# 论文阅读卡：LATTICE: Democratize High-Fidelity 3D Generation at Scale

## 书目信息
- 标题：LATTICE: Democratize High-Fidelity 3D Generation at Scale
- 作者：Zeqiang Lai, Yunfei Zhao, Zibo Zhao, Haolin Liu, Qingxiang Lin, Jingwei Huang, Chunchao Guo, Xiangyu Yue
- 发表场所/年份：CVPR，2026
- DOI/arXiv/OpenReview：CVPR 2026 论文；本地 PDF 中 identifier not found
- 代码/数据/项目：https://lattice3d.github.io
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R19_LATTICE_大规模高保真3D生成.pdf

## 问题

3D 表示要么缺少空间结构（VecSet token），要么高分辨率成本过高，因此与 2D 生成存在质量/扩展性差距。

## 核心思想

VoxSet 将紧凑 latent 锚定在粗 voxel 网格上；LATTICE 先生成稀疏几何 anchor，再用 rectified-flow transformer 生成细节，并支持 token 级 test-time scaling。

## 论文声称的贡献

- 半结构化、位置感知的 VoxSet。
- 任意分辨率解码和灵活推理。
- 推理时增加 token 数可超过训练 token 预算并改善保真。

## 方法

将资产编码为粗 anchor 和局部 latent vector，分两阶段生成，并在质量优先时增加推理 token。

## 实验设置
- 数据集/模拟器/机器人：大规模 3D 资产；具体划分 not found。
- 基线：VecSet 和其他高保真 3D 生成器。
- 指标：重建/生成质量及 token/runtime scaling；具体数值未抄录。
- 消融实验：token 数、anchor 结构和分辨率。
- 仅模拟、真实机器人或混合：静态资产，无机器人实验。

## 主要证据
- 论文直接支持的内容：VoxSet 改进结构化压缩，并在报告实验中支持分辨率/token scaling [论文摘要，Fig. 2]。
- 仍缺乏支持或证据较弱的内容：test-time scaling 会增加计算，未测试医学分布。

## 局限与失败情形

高分辨率 token 和生成成本仍高；若 decoder 不合适，结构化 latent 也未必保留任意拓扑。

## 可复用内容

预算感知 token scaling 可用于权衡解剖保真与交互延迟。

## 值得质疑之处

高分辨率输出不等于患者特异性细节准确。

## 与本项目的关系

可作为多分辨率解剖资产和渐进式复核工作流的骨干。

## 引用说明
- 本文可安全支持的论断：VoxSet、两阶段 LATTICE 和 token 级 test-time scaling（直接支持）。
- 不应使用本文支持的论断：临床重建精度或在其他硬件上的实时保证（不支持）。

