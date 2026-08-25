# 论文阅读卡：Structured 3D Latents for Scalable and Versatile 3D Generation (TRELLIS)

## 书目信息
- 标题：Structured 3D Latents for Scalable and Versatile 3D Generation
- 作者：Jianfeng Xiang, Zelong Lv, Sicheng Xu, Yu Deng, Ruicheng Wang, Bowen Zhang, Dong Chen, Xin Tong, Jiaolong Yang
- 发表场所/年份：CVPR，2025
- DOI/arXiv/OpenReview：CVPR 2025 论文；本地 PDF 中 arXiv ID not found
- 代码/数据/项目：https://trellis3d.github.io/
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R10_TRELLIS_结构化3D潜变量生成.pdf

## 问题

已有 3D 生成器常绑定单一表示：field/3DGS 渲染好但难提取，mesh 可编辑但难同时表达细致外观。

## 核心思想

Structured LATent（SLAT）将稀疏 3D 网格与密集多视图视觉特征结合，使一个 latent 可解码为 radiance field、3D Gaussian 或 mesh。

## 论文声称的贡献

- 具有格式特定 decoder 的统一结构化 latent。
- 在约 50 万资产上训练最高 2B 参数的 rectified-flow transformer。
- 支持文本/图像条件与免调优局部编辑。

## 方法

编码活跃稀疏 voxel 与局部视觉特征，先生成稀疏结构，再生成非空 cell latent，最后解码为所需表示。

## 实验设置
- 数据集/模拟器/机器人：约 50 万个精选 3D 资产；准确划分 not found。
- 基线：规模相近的近期 3D 生成模型。
- 指标：形状和外观质量比较；具体指标和值需查结果表。
- 消融实验：分析 latent 分辨率、通道数和 decoder。
- 仅模拟、真实机器人或混合：静态对象生成，无机器人实验。

## 主要证据
- 论文直接支持的内容：SLAT 支持多种输出格式，并在文本/图像条件下获得有竞争力质量 [论文摘要，§§3–5]。
- 仍缺乏支持或证据较弱的内容：decoder 和多视图特征质量可能主导结果；无临床或物理验证。

## 局限与失败情形

稀疏 latent 训练与依赖 renderer 的监督可能漏掉隐藏结构或复杂拓扑；mesh 可用性仍依赖后处理。

## 可复用内容

共享 latent + 多 decoder 很适合让几何、材质和不同解剖下游表示共用一个核心表示。

## 值得质疑之处

跨格式“通用性”不表示每个 decoder 的保真和可编辑能力完全相同。

## 与本项目的关系

可作为患者特异性 mesh、Gaussian 可视化和体数据 decoder 的共享解剖 latent。

## 引用说明
- 本文可安全支持的论断：SLAT 设计、输出格式、模型规模和编辑能力（直接支持）。
- 不应使用本文支持的论断：临床重建精度或拓扑保证（不支持）。

