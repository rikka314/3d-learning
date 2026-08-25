# 论文阅读卡：Native and Compact Structured Latents for 3D Generation

## 书目信息
- 标题：Native and Compact Structured Latents for 3D Generation
- 作者：Jianfeng Xiang, Xiaoxue Chen, Sicheng Xu, Ruicheng Wang, Zelong Lv, Yu Deng, Hongyuan Zhu, Yue Dong, Hao Zhao, Nicholas Jing Yuan, Jiaolong Yang
- 发表场所/年份：CVPR，2026
- DOI/arXiv/OpenReview：CVPR 2026 论文；本地 PDF 中 identifier not found
- 代码/数据/项目：开放项目；本地 PDF 中准确 URL not found
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R18_O-Voxel_原生紧凑结构化3D潜变量.pdf

## 问题

iso-surface 表示难处理开放、非流形和封闭内部结构，也常忽略外观/材质；大规模 3D 模型还需要紧凑 latent。

## 核心思想

O-Voxel 是同时编码几何和 PBR 属性的 field-free 稀疏 voxel；Sparse Compression VAE 压缩原生资产，再由约 4B 参数的 flow-matching generator 生成。

## 论文声称的贡献

- 支持开放、非流形和封闭内部表面的任意拓扑。
- 联合表示几何和 PBR/材质。
- 在 H100 上报告约 3 秒（512³）、17 秒（1024³）、60 秒（1536³）。

## 方法

将原生 mesh 表面和属性投影到活跃 voxel，学习稀疏压缩与重建，再用图像条件 flow matching 生成 latent token。

## 实验设置
- 数据集/模拟器/机器人：多个公共 3D 资产集；具体构成和划分 not found。
- 基线：表示比较中包括 TRELLIS、Dora、SparseFlex、Direct3D-S2。
- 指标：mesh distance、normal PSNR、材质通道重建/质量和生成速度。
- 消融实验：压缩率/token 数和 latent 设计。
- 仅模拟、真实机器人或混合：静态资产生成，无机器人实验。

## 主要证据
- 论文直接支持的内容：在报告基准上实现较强重建紧凑性和高分辨率纹理生成 [论文 Fig. 1，摘要，实验]。
- 仍缺乏支持或证据较弱的内容：没有医学或物理仿真验证。

## 局限与失败情形

训练/显存成本高，依赖精选原生资产；对细薄解剖结构和含噪扫描的行为不明确。

## 可复用内容

field-free 结构化 latent 很适合保存解剖腔体、开放表面和材质/标签通道。

## 值得质疑之处

PBR 视觉指标不能保证内部解剖结构的语义对应。

## 与本项目的关系

是拓扑感知解剖生成的高潜力表示，特别适合内部表面和材质图重要的场景。

## 引用说明
- 本文可安全支持的论断：O-Voxel 设计、拓扑范围、模型规模和报告速度（直接支持）。
- 不应使用本文支持的论断：临床解剖保真或抗噪性（不支持）。

