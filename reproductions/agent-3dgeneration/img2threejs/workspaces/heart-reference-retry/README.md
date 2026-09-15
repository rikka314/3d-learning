# 心脏 · 单图重建

基于单张 1122 × 1402 正面参考图构建的 Three.js 程序化心脏参考模型与交互查看器。模型用于视觉重建研究；侧面、背面与遮挡区域是程序化近似，不适用于医学诊断或解剖测量。

## 运行

```powershell
npm run dev
```

生产构建：

```powershell
npm run build
npm run preview -- --host 127.0.0.1 --port 4174
```

工作区沿用仓库已有的 Three.js 0.169、TypeScript 与 Vite 依赖。
在本机使用相邻工作区的依赖目录链接；在新的机器上先运行 `npm install`。

## 交互

- 左键拖拽旋转，滚轮缩放，右键拖拽平移。
- 单击部件显示中文名称并高亮该部件。
- “分解部件”展示语义部件关系；“恢复装配”返回原位。
- “自动旋转”切换缓慢转台，“正面复位”恢复参考图视角。
- `?capture=1` 进入纯白无侧栏截图模式。
- `?view=front|right|rear|left|threeQuarter` 固定复核视角，`&explode=1` 启用分解视图。
- `?capture=1&light=neutral` 与 `?capture=1&light=grazing` 使用固定材质复核光照。

## 重建范围

可见正面轮廓、大血管走向与冠状沟布局来自参考图。主体是封闭的连续曲面，血管具有实际管壁和凹入的开口，冠状分支贴合主体表面，脂肪小叶使用实例网格。

这是程序化视觉近似。心耳形状、细血管分布和脂肪小叶没有逐一精确复刻；背面、深度及遮挡连接是推断。组织纹理来自小范围参考裁片，经去除大范围明暗、调色和重复映射处理，不能视为物理材质测量或额外解剖信息。

`reference.png` 保留本次原始输入，`anatomy-layout.json` 保存参考坐标与推断深度。旧心脏示例未被覆盖。

## 验证结果

- 优化后 179,560 个三角形、73 个 draw calls；相较细分版本减少约 57.9% 三角形。
- 16 项浏览器交互检查通过，包括实际点选、拖动、自动旋转、复位、分解恢复及手机布局。
- 30 项要求部件覆盖检查通过；运行时清单另包含可选取网格的细分条目。
- 连续心室外壳采样检查：8,247 顶点中检测 917 个，未发现内部顶点，4 个样本无法确定。该结果仅覆盖心室外壳，不代表整个模型无自交。
- TypeScript、Vite 构建与截图脚本语法检查通过。未安装 ESLint；构建保留 Three.js bundle 超过 500 kB 的提示。

完整证据见 `final-report.json`、`output/reviews/optimization-pass/iteration0/` 和 `output/playwright/final-ui/interaction-report.json`。视觉审查分数是本次近似目标下的主观判断，不是解剖准确率。

## 调试接口

页面提供 `__MODEL_ROOT__`、`__MODEL_READY__`、`__CAPTURE_VIEW__`、`__RENDER_INFO__`、`__PART_MANIFEST__`、`__SET_EXPLODE__` 与 `__SELECT_PART__`，供自动截图、性能读取和部件覆盖检查使用。
必须等待 `__MODEL_READY__ === true` 后截图或选取；模型工厂的异步材质加载结果通过 `root.userData.materialReady` 提供，失败会在查看器显示提示。

## 文件

- `src/createHeartModel.ts`：程序化模型工厂，返回带 `userData.sculptRuntime` 的 `THREE.Group`。
- `src/heartMaterials.ts`、`public/textures/`：独立颜色、法线、粗糙度与 AO 通道及其来源。
- `src/main.ts`：正交相机、灯光、选取、语义分解、响应式布局与调试接口。
- `src/style.css`：桌面与移动端查看器样式。
- `output/reviews/`：不可变的各轮截图、对照图、确定性检查和人工视觉判断；失败轮次也保留。
- `output/playwright/final-ui/`：交互报告、桌面、移动端及分解截图。
- `record_review.py`：验证来源与截图哈希、检查证据完整性并记录显式审查决定。
