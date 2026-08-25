# 论文阅读卡：DreamCS: Geometry-Aware Text-to-3D Generation with Unpaired 3D Reward Supervision

## 书目信息
- 标题：Geometry-Aware Text-to-3D Generation with Unpaired 3D Reward Supervision
- 作者：Xiandong Zou, Ruihao Xia, Hongsong Wang, Pan Zhou
- 发表场所/年份：ICLR，2026
- DOI/arXiv/OpenReview：arXiv:2506.09814v3；OpenReview forum PoU33ZdtCP
- 代码/数据/项目：本地 PDF 中 not found
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R24_DreamCS_3D偏好对齐生成.pdf

## 问题

2D 偏好 reward 会偏爱视图依赖的合理外观，忽略 Janus face、不完整几何和其他全局 3D 缺陷。

## 核心思想

构建非成对 3D-MeshPref，利用 Cauchy-Schwarz divergence 训练几何感知 RewardCS，再用于隐式和显式 text-to-3D 管线。

## 论文声称的贡献

- 由 LLM 标注并经人工细化的大规模非成对 3D 偏好数据。
- 不需要 paired comparison 的 3D reward model。
- 用 DreamCS 改善几何与人类偏好。

## 方法

直接在 3D 中给单个 mesh 评分，根据 learned reward 优化生成，并与已有 text-to-3D 目标组合。

## 实验设置
- 数据集/模拟器/机器人：3D-MeshPref 和 text-to-3D 基准；准确规模/划分 not found。
- 基线：2D reward 引导和已有 text-to-3D 方法。
- 指标：人类偏好、几何/质量分数和 artifact 定性分析。
- 消融实验：reward 目标及在隐式/显式生成器中的整合。
- 仅模拟、真实机器人或混合：静态资产，无机器人实验。

## 主要证据
- 论文直接支持的内容：RewardCS 在报告实验中减少 2D reward artifact，并提升偏好/几何指标 [论文摘要，Fig. 1，实验]。
- 仍缺乏支持或证据较弱的内容：reward 质量依赖标注和评估分布，未测试临床语义。

## 局限与失败情形

非成对标签可能含噪或不一致；存在 reward hacking 和分布外 mesh 风险。

## 可复用内容

可训练解剖几何 reward，将人类偏好与显式表面/拓扑检查结合。

## 值得质疑之处

人类偏好不能替代专家解剖正确性或安全约束。

## 与本项目的关系

在硬性几何有效性 gate 建立后，可用于对齐临床医生对生成资产的偏好。

## 引用说明
- 本文可安全支持的论断：3D-MeshPref、RewardCS 目标和 DreamCS 整合（直接支持）。
- 不应使用本文支持的论断：临床可接受性或保证消除几何 artifact（不支持）。

