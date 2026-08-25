# 论文阅读卡：MeshArt: Generating Articulated Meshes with Structure-Guided Transformers

## 书目信息
- 标题：MeshArt: Generating Articulated Meshes with Structure-Guided Transformers
- 作者：Daoyi Gao, Yawar Siddiqui, Lei Li, Angela Dai
- 发表场所/年份：CVPR，2025
- DOI/arXiv/OpenReview：CVPR 2025 论文；本地 PDF 中 identifier not found
- 代码/数据/项目：本地 PDF 中 not found
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R16_MeshArt_结构引导的关节网格生成.pdf

## 问题

可动资产需要紧凑几何和功能关节，但多数 3D 生成器只能生成静态、融合形状。

## 核心思想

先生成带 articulation 的部件包围 primitive，再根据结构和局部连接条件生成各部件的 triangle 序列。

## 论文声称的贡献

- 用于 articulated mesh 生成的分层 transformer。
- 保证部件过渡的结构引导条件。
- 为 PartNet 三个类别加入关节标注，使 articulated 数据增加 6 倍以上。

## 方法

自回归量化并生成结构 token（部件语义、box、articulation mode），再在结构和邻接条件下生成各部件 mesh triangle。

## 实验设置
- 数据集/模拟器/机器人：增强 PartNet，覆盖 table、chair、storage 三类。
- 基线：mesh 和 articulated object 生成基线。
- 指标：structure coverage 和 mesh-generation FID；论文报告 coverage 提升 57.1%、FID 改善 209 点。
- 消融实验：结构引导与连接条件。
- 仅模拟、真实机器人或混合：静态 articulated mesh 数据，无真实机器人测试。

## 主要证据
- 论文直接支持的内容：在其 articulated 基准上改善结构覆盖和 mesh FID [论文摘要，§4]。
- 仍缺乏支持或证据较弱的内容：类别很窄，不能证明关节物理有效。

## 局限与失败情形

关节标注稀缺、自回归误差累积、类别有限，部件接口可能出现 mesh artifact。

## 可复用内容

解剖层次/关节与局部表面生成应分开建模，并加入显式连接和关节约束。

## 值得质疑之处

Mesh FID 不能替代活动范围、碰撞或生物力学验证。

## 与本项目的关系

适用于可动解剖、手术工具和器官运动代理，但需用临床运动学标注替换 PartNet。

## 引用说明
- 本文可安全支持的论断：分层设计、数据增强和报告的基准差值（直接支持）。
- 不应使用本文支持的论断：真实关节行为或临床生物力学（不支持）。

