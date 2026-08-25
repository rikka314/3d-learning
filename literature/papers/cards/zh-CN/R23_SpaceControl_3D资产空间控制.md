# 论文阅读卡：SpaceControl: Introducing Test-Time Spatial Control to 3D Generative Modeling

## 书目信息
- 标题：SpaceControl: Introducing Test-Time Spatial Control to 3D Generative Modeling
- 作者：Elisabetta Fedele, Francis Engelmann, Ian Huang, Or Litany, Marc Pollefeys, Leonidas Guibas
- 发表场所/年份：ICLR，2026
- DOI/arXiv/OpenReview：arXiv:2512.05343v2；OpenReview 会议版本
- 代码/数据/项目：https://spacecontrol3d.github.io/
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R23_SpaceControl_3D资产空间控制.pdf

## 问题

用户需要精确几何控制时，文本存在歧义，图像又难直接编辑。

## 核心思想

训练免费的 test-time 方法将 superquadric 等粗 primitive 或 mesh 输入现有 3D 生成器，并用控制参数在几何忠实度与真实感间权衡。

## 论文声称的贡献

- 无需重新训练基础生成器的空间控制。
- 支持从粗到细的几何草图和交互式编辑。
- 在定量和用户研究中优于训练式和优化式基线。

## 方法

将输入几何转换为 guidance feature，在生成/去噪过程中注入，并在推理时调整控制强度。

## 实验设置
- 数据集/模拟器/机器人：3D 资产生成基准和交互式 superquadric 界面；具体划分 not found。
- 基线：训练式空间控制与 test-time 优化方法。
- 指标：几何忠实度、视觉质量和用户偏好。
- 消融实验：控制强度和输入几何。
- 仅模拟、真实机器人或混合：静态资产，无机器人实验。

## 主要证据
- 论文直接支持的内容：在其评测中提升几何忠实度并保持视觉质量 [论文摘要，§§4–5]。
- 仍缺乏支持或证据较弱的内容：没有报告对含噪医学几何的运行时和鲁棒性。

## 局限与失败情形

过粗或不准确草图会约束错误形状；test-time guidance 仍增加开销；输出依赖 decoder。

## 可复用内容

可把临床医生可编辑的 3D 草图或器官模板作为控制通道，而无需重训每个生成器。

## 值得质疑之处

用户偏好的“忠实几何”未必等于测量级解剖准确。

## 与本项目的关系

适合作为交互式解剖修正与手术规划资产编辑的界面层。

## 引用说明
- 本文可安全支持的论断：训练免费空间引导、控制权衡和报告评测趋势（直接支持）。
- 不应使用本文支持的论断：无训练即可临床鲁棒或任意硬件实时（不支持）。

