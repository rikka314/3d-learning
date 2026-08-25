# 论文阅读卡：Text-Image Conditioned 3D Generation (TIGON)

## 书目信息
- 标题：Text-Image Conditioned 3D Generation
- 作者：Jiazhong Cen, Jiemin Fang, Sikuang Li, Guanjun Wu, Chen Yang, Taoran Yi, Zanwei Zhou, Zhikuan Bao, Lingxi Xie, Wei Shen, Qi Tian
- 发表场所/年份：CVPR，2026
- DOI/arXiv/OpenReview：CVPR 2026 论文；本地 PDF 中 identifier not found
- 代码/数据/项目：https://jumpat.github.io/tigon-page
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R22_TIGON_文本图像条件3D生成.pdf

## 问题

仅图像条件能保留观察到的外观但会幻觉遮挡区域；仅文本条件语义灵活但缺少精确视觉细节。

## 核心思想

使用独立的图像条件和文本条件 backbone，加上轻量跨模态融合，正式定义 text-image-conditioned 3D generation。

## 论文声称的贡献

- 诊断实验表明两种模态互补，并优于单模态/简单 late fusion。
- 提出用于联合推理的极简双分支基线。
- 联合条件改善语义对齐和视觉保真。

## 方法

分别编码图像和文本，融合特征，再通过底层生成/重建管线预测 3D 资产。

## 实验设置
- 数据集/模拟器/机器人：带图像/文本条件的 3D 资产；具体数据和划分 not found。
- 基线：image-only、text-only、late-fusion 与单模态模型。
- 指标：生成质量和条件对齐；具体名称未抄录。
- 消融实验：模态与融合诊断。
- 仅模拟、真实机器人或混合：静态资产，无机器人实验。

## 主要证据
- 论文直接支持的内容：联合条件在报告实验中持续优于单模态方法 [论文摘要，§3]。
- 仍缺乏支持或证据较弱的内容：只是基线设计，开放域和医学泛化未测试。

## 局限与失败情形

冲突或低信息模态会干扰融合；未见区域仍欠约束；双 encoder 增加计算。

## 可复用内容

可联合临床图像证据与文本解剖/结构约束，而不是让任一模态承担全部信息。

## 值得质疑之处

感知对齐改善不能证明文本正确消解隐藏解剖歧义。

## 与本项目的关系

直接适用于多模态患者特异性资产生成，但应使用医学 prompt 与结构标签替换通用文本。

## 引用说明
- 本文可安全支持的论断：单模态瓶颈、双分支设计和报告的比较趋势（直接支持）。
- 不应使用本文支持的论断：隐藏解剖或临床决策正确（不支持）。

