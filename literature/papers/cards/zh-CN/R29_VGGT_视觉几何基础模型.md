# 论文阅读卡：VGGT: Visual Geometry Grounded Transformer

## 书目信息
- 标题：VGGT: Visual Geometry Grounded Transformer
- 作者：Jianyuan Wang, Minghao Chen, Nikita Karaev, Andrea Vedaldi, Christian Rupprecht, David Novotny
- 发表场所/年份：CVPR，2025
- DOI/arXiv/OpenReview：arXiv:2503.11651
- 代码/数据/项目：本地 PDF 中 not found
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R29_VGGT_视觉几何基础模型.pdf

## 问题

经典多视图重建依赖迭代优化，并分别使用模型预测相机、深度、point map 和 track。

## 核心思想

一个大型 feed-forward transformer 从一张到数百张图像联合预测 camera、point map、depth map 和 point track，显式 3D inductive bias 很少。

## 论文声称的贡献

- 统一的 geometry foundation model。
- 在宣传输入范围内推理低于一秒。
- 在相机、深度、点云和 tracking 任务上达到有竞争力/SOTA 结果。

## 方法

用全局和局部交互编码 image token，再一次前馈解码 task token 和逐图几何输出。

## 实验设置
- 数据集/模拟器/机器人：多个 3D 标注数据；卡片来源未完整列出训练混合。
- 基线：Bundle Adjustment/优化管线和 learned geometry model。
- 指标：camera pose、depth、point-cloud reconstruction 和 3D tracking 指标。
- 消融实验：输入数量、模型规模和局部/detail token。
- 仅模拟、真实机器人或混合：公共合成与真实图像基准，无机器人部署。

## 主要证据
- 论文直接支持的内容：联合前馈几何预测在多个基准上无需后处理即可优于部分优化方法 [论文摘要，§4，结论]。
- 仍缺乏支持或证据较弱的内容：性能依赖训练分布、相机约定和场景覆盖。

## 局限与失败情形

新域、严重遮挡、动态场景和 metric scale 歧义仍困难；point map 本身不是 mesh。

## 可复用内容

可将 VGGT 作为生成式解剖管线之前/内部的几何 encoder、camera estimator 或一致性模块。

## 值得质疑之处

快速推理不能取消医学标定、不确定性估计和配准验证。

## 与本项目的关系

很适合作为患者多视图/视频重建基础，并可用显式几何监督生成模型。

## 引用说明
- 本文可安全支持的论断：联合输出、前馈设计和基准任务范围（直接支持）。
- 不应使用本文支持的论断：临床重建精度或未经额外验证的动态解剖（不支持）。

