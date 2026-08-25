# 论文阅读卡：DreamFusion: Text-to-3D using 2D Diffusion

## 书目信息
- 标题：DreamFusion: Text-to-3D using 2D Diffusion
- 作者：Ben Poole, Ajay Jain, Jonathan T. Barron, Ben Mildenhall
- 发表场所/年份：arXiv，2022
- DOI/arXiv/OpenReview：arXiv:2209.14988v1
- 代码/数据/项目：https://dreamfusion3d.github.io/
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R08_DreamFusion_基于二维扩散的文本到3D.pdf

## 问题

当时缺少大规模标注 3D 数据和高效 3D diffusion，而 text-to-image diffusion 已包含广泛视觉先验。

## 核心思想

从预训练 2D 文生图 diffusion 推导 Score Distillation Sampling（SDS），优化 NeRF，使其随机视角渲染符合文本先验。

## 论文声称的贡献

- 不使用 3D 训练数据的 text-to-3D。
- 可配合冻结 2D diffusion 使用的概率密度蒸馏损失。
- 输出可多角度观看和重光照的 NeRF，而非单张图像。

## 方法

随机采样相机，渲染 NeRF，加入 diffusion 噪声，将 SDS 梯度反传到 NeRF 参数，并用密度正则和视角提示稳定优化。

## 实验设置
- 数据集/模拟器/机器人：文本 prompt 和合成 NeRF 优化，无命名训练数据集。
- 基线：讨论早期 text-to-3D/CLIP 方法，但没有完整统一基准。
- 指标：定性渲染和文本-图像相似性分析；完整指标协议 not found。
- 消融实验：附录分析 guidance、随机种子和优化选择。
- 仅模拟、真实机器人或混合：仅模拟/渲染。

## 主要证据
- 论文直接支持的内容：冻结的 2D diffusion 先验可以从文本优化 3D NeRF [论文摘要，§§3–4]。
- 仍缺乏支持或证据较弱的内容：未证明可靠拓扑、所有 prompt 下的视图一致性或生产速度。

## 局限与失败情形

逐样本优化慢；2D 先验会导致 Janus、多视图不一致、背面缺失和几何过度平滑。

## 可复用内容

SDS 仍可作为测试新 3D 表示能否吸收 2D 语义先验的基线。

## 值得质疑之处

少量渲染视角的视觉合理性不能证明完整 3D 结构或物理有效性。

## 与本项目的关系

可作为解剖条件生成的历史基线，但若无 amortization 和更强几何监督，不适合大规模患者特异性处理。

## 引用说明
- 本文可安全支持的论断：无 3D 训练数据的 SDS text-to-3D（直接支持）。
- 不应使用本文支持的论断：快速推理、watertight mesh 或临床重建（不支持）。

