# 心脏外部解剖修正版

当前模型以用户四视图为形体参考，按正常成人外部心脏解剖修正；冠脉采用右冠优势教学示例。使用程序化 Three.js 网格，不是患者扫描重建。知识检查结论与证据索引见 `knowledge-review.md` 和 `final-report.json`。

当前版本结合原始四视图调整心房/心耳包覆、下半心室厚度、主动脉后伸与展示截端，加入贴面脂肪带及13条连接母干的示意细支。四向轮廓指标均改善；最终通过88项结构与区域标注、216组血管间距和12项交互检查。对比见 [四视图对照](output/reference-final-03/comparison.html)，范围及未匹配项见 [reference-refinement.md](reference-refinement.md)，最终证据为 `output/reference-final-03/`。

上一轮材质记录保存在 [surface-review.md](surface-review.md) 和 `output/material-final/`；其中“布局未变”及36/108项结果只描述该历史阶段。

主要改动：区分左右心室外表面和左室心尖；为肺动脉干建立共同分叉；调整四肺静脉、上下腔静脉和心耳的外部连接；修正冠状动脉的起源、房室沟/室间沟走行；加入冠状窦及大、中、小心静脉；纠正管壁交叠与样条穿入心室的问题。形体参数在 `anatomy-layout.json`，冠脉实现位于 `src/coronaryAnatomy.ts`。

## 查看与构建

```powershell
npm run dev -- --port 4175 --strictPort
npm run build
```

打开 http://127.0.0.1:4175/ 。支持旋转、缩放、点选部件、四向视角、分解恢复。+Z 为前方，+X 为解剖左侧；四个视角均来自同一模型。`?capture=1&view=left` 为纯白截图模式。

本机沿用已有 Three.js 0.169 / Vite 依赖目录链接，没有添加依赖。新环境按 `package.json` 安装所需依赖。

## 知识检查与证据

`anatomy-contract.json` 定义外部解剖检查范围。验证读取实际运行网格、血管中心线及顶点环半径，并核对本地源码与浏览器所服务源码的 SHA-256。

```powershell
# 先配置已有 Playwright 的 NODE_PATH；每次捕获使用未存在的新名称
node capture.cjs anatomy-new
node verify-anatomy.cjs anatomy-new
node verify-vessel-clearance.cjs anatomy-new
node verify-ui.cjs anatomy-new-ui
```

- `verify-anatomy.cjs`：外表面分区、心耳基底相交、大血管外部根部、冠脉必需连接、沟内走行及主要前方血管贴面采样。
- `verify-vessel-clearance.cjs`：13条大血管的72个非连接管对、18条冠状动脉与8条心静脉的144个动静脉管对。采用501点轴线采样、实际顶点环半径和采样余量；属于有范围的几何检查，不是精确全模型无自交证明。
- `verify-ui.cjs`：四向切换、键盘操作、实际点选、分解/恢复、自动旋转及390×844手机布局。
- `knowledge-review.md`：结合权威解剖资料、最终四视图和独立解剖复查的知识性结论；自动脚本通过不能代替该复查。

左右心室共用一个封闭外壳，按三角面分成两个语义区域。模型没有建立四个真实空腔、瓣膜、隔膜或可贯通管腔；截口里的短凹孔只是展示结构。房室体块、心耳、管径、纹理和细支数量仍属简化。红蓝按含氧状态教学着色，血管身份依据起源和回流关系。

## 原图拟合的历史状态

生物学修正优先于未经标定的插图细节。原图像拟合流程的 blockout 状态和失败历史保留，本轮不将它改写为图像质量通过。

| 历史候选视图 | 轮廓 IoU | Tier 1 |
|---|---:|---|
| 前面 | 0.9398 | 通过 |
| 解剖左侧 | 0.7794 | 未通过 |
| 后面 | 0.8682 | 未通过 |
| 解剖右侧 | 0.7573 | 未通过 |

上述数值只属于原候选，不能用于当前解剖修正版。原候选源码及说明保存在 `output/anatomy-before/`；原图像诊断在 `output/final-candidate/`、`output/verified-02/`，没有覆盖。另一个单图工作区 `../heart-reference-retry/` 也保持独立。

## 关键文件

- `reference-sheet.png`、`references.json`、`references/`：用户原图、四向裁切与来源哈希。
- `src/createHeartModel.ts`：心室外壳、心房/心耳和大血管；`src/coronaryAnatomy.ts`：冠状动静脉；`src/main.ts`：查看器。
- `anatomy-layout.json`：当前形体参数；`object-sculpt-spec.json` 的 `anatomyRevision` 说明本轮范围与旧流程关系。
- `final-report.json`：最终截图、构建、交互和知识检查的机器可读索引。
- `src/heartMaterials.ts`：当前对象空间程序化表面材质；可克隆的shader保留选择高亮及去纹理诊断行为。
- `public/textures/`：上一轮参考裁片衍生素材，仅作为历史资产保留，当前材质不再加载。
- `prepare_references.py`、`author_variant.py`：只用于首次初始化；已有 reference/spec 时拒绝覆盖。
