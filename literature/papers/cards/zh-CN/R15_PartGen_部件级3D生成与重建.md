# 论文阅读卡：PartGen: Part-level 3D Generation and Reconstruction with Multi-View Diffusion Models

## 书目信息
- 标题：Part-level 3D Generation and Reconstruction with Multi-View Diffusion Models
- 作者：Minghao Chen, Roman Shapovalov, Iro Laina, Tom Monnier, Jianyuan Wang, David Novotny, Andrea Vedaldi
- 发表场所/年份：CVPR，2025
- DOI/arXiv/OpenReview：CVPR 2025 论文；本地 PDF 中 identifier not found
- 代码/数据/项目：https://silent-chen.github.io/PartGen
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R15_PartGen_部件级3D生成与重建.pdf

## 问题

文本/图像生成器和扫描器常生成融合的单体 3D，而编辑、复用和动画需要语义明确、可独立操作的部件。

## 核心思想

第一个多视图 diffusion 采样视图一致的部件分割，第二个模型在整物体上下文中补全各部件，再做确定性 3D 重建。

## 论文声称的贡献

- 支持从文本、图像和非结构化 3D 生成由部件组成的对象。
- 支持遮挡感知部件补全。
- 展示文本引导的部件编辑。

## 方法

生成多组彩色分割假设并跨视图聚合，利用上下文 diffusion 补全部分/完全隐藏部件，分别重建后组合成一致对象。

## 实验设置
- 数据集/模拟器/机器人：艺术家制作和扫描的 3D 资产；具体基准与划分 not found。
- 基线：分割和部件补全方法。
- 指标：部件分割/补全质量和定性编辑；具体指标值未抄录。
- 消融实验：采样与上下文补全组件。
- 仅模拟、真实机器人或混合：静态资产，无机器人实验。

## 主要证据
- 论文直接支持的内容：PartGen 优于所比较分割/补全基线，并支持部件编辑 [论文摘要，§§3–5]。
- 仍缺乏支持或证据较弱的内容：补全可能幻觉不可见解剖，评测不是临床评测。

## 局限与失败情形

部件语义取决于艺术家；不可见部件具有内在歧义；独立重建会产生 seam 或接口错误。

## 可复用内容

上下文部件补全可用于存在遮挡的器官、器械和手术装配体。

## 值得质疑之处

娱乐资产的“有意义部件”标签不能自动对应解剖 ontology。

## 与本项目的关系

可作为可编辑解剖部件架构，但必须改用医学标注的部件与补全目标。

## 引用说明
- 本文可安全支持的论断：多视图分割/补全管线和输入模态（直接支持）。
- 不应使用本文支持的论断：幻觉出的隐藏解剖正确（不支持）。

