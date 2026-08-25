# 论文阅读卡：AssetGen: Deployable 3D Asset Generation at Interactive Speed

## 书目信息
- 标题：AssetGen: Deployable 3D Asset Generation at Interactive Speed
- 作者：Dilin Wang, Xiaoyu Xiang, Kihyuk Sohn, Tom Monnier, Yu-Ying Yeh, Thu Nguyen-Phuoc, Jiawen Zhang, Yuchen Fan, Antoine Toisoul, Hyunyoung Jung, Prithviraj Dhar, Michael Bunnell, Nikolaos Sarafianos, Chuhang Zou, Roman Shapovalov, Andrea Vedaldi, Rakesh Ranjan
- 发表场所/年份：arXiv 预印本，2026
- DOI/arXiv/OpenReview：arXiv:2605.26137v1
- 代码/数据/项目：本地 PDF 中 not found
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R20_AssetGen_可部署交互速度3D资产生成.pdf

## 问题

研究系统常只追求分辨率，忽略端到端延迟、UV、法线、polygon budget 和部署约束。

## 核心思想

协同设计 coarse-to-refine VecSet mesh 生成、GPU 简化/清理、UV unwrap、normal baking、多视图纹理、backprojection、inpainting、蒸馏和 pipeline parallelism。

## 论文声称的贡献

- 约 30 秒从参考图像生成带 baked normal、颜色纹理和可控面数的 mesh。
- AssetGen Flash 约 14 秒生成预览。
- 在 AssetBench 和 CharacterBench 上做自动与盲测人工评估。

## 方法

先生成几何并在 GPU 简化/清理，展开 UV，合成多视图纹理，backproject/blend 到 atlas，再补全未观测区域并序列化运行时资产。

## 实验设置
- 数据集/模拟器/机器人：AssetBench、CharacterBench；H100 延迟测量。
- 基线：领先商业系统和已有生成器。
- 指标：视觉质量、资产可用性、延迟和人类偏好；具体值未抄录。
- 消融实验：kernel/precision、蒸馏、pipeline 和后处理组件。
- 仅模拟、真实机器人或混合：静态资产，无机器人硬件。

## 主要证据
- 论文直接支持的内容：完整资产管线可在交互式延迟下提供有竞争力的视觉质量 [论文摘要，§§6–9]。
- 仍缺乏支持或证据较弱的内容：作者明确承认 marching-cubes/topology 限制，且无临床数据。

## 局限与失败情形

不保证 artist-friendly topology、rigging 和 deformation；遮挡和细薄结构会使 backprojection/inpainting 失败；仍有 domain gap。

## 可复用内容

应把后处理、延迟和资产序列化当作一等输出，而非模型生成后的附属步骤。

## 值得质疑之处

“Deployable” 取决于目标引擎与硬件；H100 上 30 秒不是普适交互保证。

## 与本项目的关系

可作为生产导向解剖资产管线的系统基线，但需增加分割、拓扑和不确定性审计。

## 引用说明
- 本文可安全支持的论断：管线组件、30/14 秒报告延迟和命名评测（直接支持）。
- 不应使用本文支持的论断：artist-quality topology、临床部署或生物力学有效性（不支持）。

