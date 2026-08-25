# 论文阅读卡：HY3D-Bench: Generation of 3D Assets

## 书目信息
- 标题：HY3D-Bench: Generation of 3D Assets
- 作者：Tencent Hunyuan3D 团队（PDF 末尾按名字字母顺序列出贡献者）
- 发表场所/年份：arXiv 预印本，2026
- DOI/arXiv/OpenReview：arXiv:2602.03907v1
- 代码/数据/项目：https://github.com/Tencent-Hunyuan/HY3D-Bench；https://huggingface.co/datasets/tencent/HY3D-Bench
- 原始本地 PDF（完整路径）：D:\Learn\20_Projects\3dresearch\3d-learning\literature\papers\精选\R06_HY3D三维数据与评测基准.pdf

## 问题

原始网络 3D 数据存在非 watertight 几何、尺度/方向不一致、渲染质量差和部件标注弱等问题，导致训练和比较不稳定。

## 核心思想

提供经过处理的生态：高保真 watertight 对象与渲染、部件级分解、固定的 400 对象基准，以及合成长尾资产。

## 论文声称的贡献

- 清洗后得到 252,000 个训练就绪对象。
- 240,524 个部件级样本和 125,000 个 AIGC 长尾合成资产。
- 标准化指标、基线和配置，并用 Hunyuan3D-2.1-Small 验证。

## 方法

对 Objaverse/Objaverse-XL 进行筛选与归一化，生成 watertight 表面、多视图渲染、部件分解和 text/image-to-3D 合成数据，再封装为基准。

## 实验设置
- 数据集/模拟器/机器人：Objaverse 和 Objaverse-XL 派生数据；19 个顶级类别；400 个保留测试对象。
- 基线：Hunyuan3D-2.1-Small 和论文引用的 3D 生成基线。
- 指标：基准定义的标准几何/生成指标；具体名称与实现应查数据集发布页。
- 消融实验：通过下游训练比较验证不同数据组成。
- 仅模拟、真实机器人或混合：静态 3D 资产，无机器人硬件研究。

## 主要证据
- 论文直接支持的内容：发布的处理管线及清洗数据对下游模型的效用 [论文 §§3–6，结论]。
- 仍缺乏支持或证据较弱的内容：增益只在作者模型和基准上验证，未测试医学分布迁移。

## 局限与失败情形

数据以静态对象为主；合成资产可能引入 domain gap；自动 watertight 和部件标签仍可能出错。

## 可复用内容

可复用其数据契约：规范方向、watertight 检查、多视图渲染、部件图和固定测试划分。

## 值得质疑之处

“高保真”是筛选标准，不等于解剖真实或适用于临床/仿真。

## 与本项目的关系

其预处理和基准封装可迁移到 CT/MRI 表面数据，但需要增加模态特定的分割与配准检查。

## 引用说明
- 本文可安全支持的论断：数据规模、组成和 400 对象基准（直接支持）。
- 不应使用本文支持的论断：医学数据质量、临床泛化或真实机器人性能（不支持）。

