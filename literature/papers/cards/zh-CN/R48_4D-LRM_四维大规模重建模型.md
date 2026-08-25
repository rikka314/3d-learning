# 论文阅读卡：4D-LRM: Large Space-Time Reconstruction Model From and To Any View at Any Time

## 书目信息
- 标题：4D-LRM: Large Space-Time Reconstruction Model From and To Any View at Any Time
- 作者：Ziqiao Ma, Xuweiyi Chen, Shoubin Yu, Sai Bi, Kai Zhang, Ziwen Chen, Sihan Xu, Jianing Yang, Zexiang Xu, Kalyan Sunkavalli, Mohit Bansal, Joyce Chai, Hao Tan
- 发表场所/年份：arXiv 预印本，2025
- DOI/arXiv/OpenReview：arXiv:2506.18890v1
- 代码/数据/项目：https://4dlrm.github.io/
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R48_4D-LRM_四维大规模重建模型.pdf

## 问题

已有 4D 系统在效率、泛化和保真之间权衡，尤其难处理跨时间稀疏有 pose 观测。

## 核心思想

从跨时间的 posed image token 直接预测逐像素 4D Gaussian primitive，学习统一时空表示并渲染任意 view-time 组合。

## 论文声称的贡献

- 从不受限视角/时间戳输入进行大规模 4D 重建。
- 在 A100 上单次前馈重建 24 帧序列低于 1.5 秒。
- 跨视角/时间泛化，并用于 4D asset generation。

## 方法

把 posed image 和 timestamp 转换为时空 token，预测 Gaussian primitive，再渲染任意时间的新视角。

## 实验设置
- 数据集/模拟器/机器人：Objaverse 派生的 32K 动画对象、783K 静态对象；Consistent4D、Objaverse4D 测试及 GSO 评测。
- 基线：多视图 diffusion、GS-LRM 和 4D 生成方法。
- 指标：在 canonical/random render view 上平均 PSNR、SSIM、LPIPS。
- 消融实验：相机设置、输入视图、模型组件和 4D 生成设置。
- 仅模拟、真实机器人或混合：渲染合成/资产数据，无机器人实验。

## 主要证据
- 论文直接支持的内容：在所述 4D 测试上改善报告渲染指标，并实现 24 帧快速推理 [论文摘要，§5，Tables 1–4]。
- 仍缺乏支持或证据较弱的内容：真实泛化受以资产/渲染数据为主的训练集限制。

## 局限与失败情形

作者指出输入上下文有限、训练分辨率仅 256²、高分辨率微调昂贵、序列短、遮挡和长程依赖困难 [论文 §6]。

## 可复用内容

显式 4D Gaussian 接口可用于从带时间戳临床观测快速渲染新 view-time。

## 值得质疑之处

渲染 PSNR/SSIM/LPIPS 不能验证几何拓扑或生理运动。

## 与本项目的关系

直接相关于 4D 器官重建，但必须用患者变形数据替代动画对象运动。

## 引用说明
- 本文可安全支持的论断：架构、数据规模、指标和报告的低于 1.5 秒结果（直接支持）。
- 不应使用本文支持的论断：鲁棒患者重建或高分辨率临床成像（不支持）。

