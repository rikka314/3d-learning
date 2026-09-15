# 心脏四视图重试

用户提供的 1254×1254 心脏四视图 → img2threejs 程序化 Three.js 模型。**本次重试已生成可运行候选，但没有通过完整四视图质量门槛。** 当前停在 blockout，后续结构、材质等阶段没有被标记为通过。

独立工作区保留了之前的单图版本 `../heart-reference-retry/`。这次复用其模型工厂和组织纹理，重新拟合心室轮廓、深度、心房体积、大血管路径；修正解剖左/右相机标签。不是神经网络直接生成网格，也不是相机标定后的精确重建。

## 查看

```powershell
npm run dev -- --port 4175 --strictPort
```

打开 http://127.0.0.1:4175/ 。拖拽旋转、滚轮缩放、点击识别部件；四视图、分解恢复、自动旋转均可使用。`?capture=1&view=left` 可进入纯白截图视图。+Z 为前方，+X 为解剖左侧。

```powershell
npm run build
```

本机沿用已有 Three.js 0.169/Vite 依赖目录链接；新机器需要按 package.json 安装依赖。

## 实际验证

| 参考视图 | 对齐轮廓 IoU | Tier 1 |
|---|---:|---|
| 前面 | 0.9398 | 通过 |
| 解剖左侧 | 0.7794 | 未通过轮廓和占比 |
| 后面 | 0.8682 | 未通过宽高比 |
| 解剖右侧 | 0.7573 | 未通过轮廓、宽高比和占比 |

轮廓门槛 0.85，宽高比差门槛 0.05，占比差门槛 0.08。分数来自脚本的投影图像比较，不是医学准确率；四张插图没有标定，前后/左右轮廓也不是严格的正交相机对应。

- TypeScript + Vite production build 通过；保留已有 >500 kB bundle 提示，未安装 ESLint。
- 12 项浏览器检查通过，含实际点选、分解/精确恢复、四向按钮、键盘、手机 390×844 布局；运行时 console/HTTP 错误为 0。
- 179,560 triangles，73 draw calls。30 个指定语义部件覆盖通过；运行时清单含 104 个分组和子网格条目。
- 心室外壳采样 2,749/8,247 顶点，检测内部点 0，不确定点 69；不证明全部血管、交叠心房或全模型无自交。早期未提供顶点法线的 centroid 检查出现假阳性，保留在早期输出中。
- turntable 和非退化侧视检查通过；attachment-anchor 工具没有检测到其适用的配饰类连接（attachmentCount=0），不能据此声称血管连接关系已经通过。
- 所有四视图均来自同一可旋转模型。`verified-02` 检查实际服务源码、材质文件 SHA256；其五张 PNG 与 `final-candidate` 诊断输入逐字节相同。

## 尚存差异

侧面心房覆盖范围、肺动脉干遮挡和大血管根部仍不够接近参考；背面的横向冠状沟与分支不足，肌理沿用旧裁片，心耳仍偏椭球。不能称为高保真重建。后续应先进一步处理侧面形体和相机差异，再解锁后壁结构与材质阶段。

## 文件与证据

- `reference-sheet.png` / `references.json` / `references/`：原图、稳定 viewId、无生成式编辑的裁切、哈希与归一化说明。
- `anatomy-layout.json`：当前最终形体参数；`object-sculpt-spec.json`：规范、继承来源与失败迭代记录。
- `src/createHeartModel.ts`：封闭心室 loft、心房、空心管口、冠脉与脂肪；`src/main.ts`：交互查看器。
- `output/four-view-result.png`：候选四向汇总；`output/final-candidate/comparisons/`：每个视角的参考/渲染对照。
- `output/final-candidate/`：四向 Tier 1、内部差异、turntable、外壳采样等诊断。
- `output/verified-02/report.json`：实际服务与本地文件绑定的截图证据；`output/source-verification.json`：与诊断 PNG 的哈希一致性。
- `output/ui/report.json`：最近一次交互结果；`final-report.json`：整体结果和未通过项。
- `prepare_references.py` / `author_variant.py`：仅供首次初始化；检测到已有 reference/spec 时拒绝覆盖。当前最终布局由后续迭代形成，以 `anatomy-layout.json` 为准。
- `capture.cjs` / `verify-ui.cjs` 使用已有 Playwright（本机可通过 bundled runtime 的 NODE_PATH 加载）；`review_pass.py <stage> <pass>` 调用上游诊断，不自动打视觉分或自动批准。

组织纹理来源保留在 `public/textures/`，是上一轮参考裁片的衍生素材，不冒充本张四视图的材质提取结果。此模型用于外观重建研究。
