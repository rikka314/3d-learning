# 论文阅读卡：4DWorldBench: A Comprehensive Evaluation Framework for 3D/4D World Generation Models

## 书目信息
- 标题：4DWorldBench: A Comprehensive Evaluation Framework for 3D/4D World Generation Models
- 作者：Yiting Lu, Wei Luo, Peiyan Tu, Haoran Li, Hanxin Zhu, Zihao Yu, Xingrui Wang, Xinyi Chen, Xinge Peng, Xin Li, Zhibo Chen
- 发表场所/年份：CVPR，2026
- DOI/arXiv/OpenReview：CVPR 2026 论文
- 代码/数据/项目：https://yeppp27.github.io/4DWorldBench/
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R41_4DWorldBench_三维四维世界生成评测.pdf

## 问题

已有视频、world model 和物理基准各自只覆盖感知质量、条件对齐、物理真实或 4D 一致性的一部分。

## 核心思想

建立多模态、物理感知基准，并按维度选择混合评估工具：feature metric、MLLM/LLM QA 和 human study。

## 论文声称的贡献

- 统一评估感知质量、condition-4D alignment、物理真实、4D 一致性。
- 支持文本、图像和视频条件。
- 提出 adaptive dimension selection（AdaDimen）与混合 QA。

## 方法

必要时把非文本条件转换为文本描述，提出维度特定问题，组合 model-based、feature-based、QA 分数，并用 human study 验证可靠性。

## 实验设置
- 数据集/模拟器/机器人：精选文本/图像/视频；物理与非物理子集，包括 Objaverse-XL 派生内容和 WISA 相关物理数据。
- 基线：视频/world generation evaluator 和训练式 VideoPhy 类物理评估器。
- 指标：四个主维度的 model/feature/LLM/MLLM 分数；物理 QA 使用 PC、SA 和联合分数。
- 消融实验：AdaDimen、问题丰富度和混合评估组件。
- 仅模拟、真实机器人或混合：生成视觉世界，无真实机器人实验。

## 主要证据
- 论文直接支持的内容：自适应/混合评估在报告实验中提升可靠性/表现，并覆盖已有基准遗漏维度 [论文摘要，§§3–5，结论]。
- 仍缺乏支持或证据较弱的内容：自动物理判断是间接的，不能验证真实力学。

## 局限与失败情形

LLM/MLLM judge 偏差、caption 转换损失、prompt 覆盖有限，且视频物理合理性与真实/仿真物理之间有差距。

## 可复用内容

可将其维度拆分用于 4D 解剖：视觉质量、条件对齐、变形合理性和时间对应。

## 值得质疑之处

physics-aware 视频分数不能解释为经过验证的生物力学仿真。

## 与本项目的关系

可作为时间器官/场景生成的评测框架，但应以医学专家和生物力学指标替换通用物理 QA。

## 引用说明
- 本文可安全支持的论断：四个评估维度、混合方法和基准范围（直接支持）。
- 不应使用本文支持的论断：临床或生物力学有效性（不支持）。

