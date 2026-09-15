# AI_CONTEXT.md

## TL;DR

- 这是 `3d-learning` 下的 img2threejs Windows 基线复现，不是新的独立产品仓库；当前快照含一个向后兼容的本地多视图 AI 工作流扩展。
- 上游源代码在 `upstream/`，官方可视化应用在 `showcase/`。
- 默认验证对象是 `workspaces/crown-chest/reference.png` 与 showcase 路由 `#/x/crown-chest`。
- 安装、验证、启动分别使用 `scripts/setup.ps1`、`scripts/verify.ps1`、`scripts/serve.ps1`。
- 不要把官方 Crown Chest showcase 结果表述为本地 agent 从零生成的结果。
- 用户心脏参考图的独立重试在 `workspaces/heart-reference-retry/`：手写模型工厂、组织纹理、中文交互查看器和逐轮审查证据；未替换官方 showcase。
- 用户四视图的新重试在 `workspaces/heart-multiview-retry/`（本地端口 4175）：独立保留原图、四向 reference-set、形体参数及源码绑定截图。候选可运行，12 项 UI 检查通过；四向 Tier 1 仅 front 通过，流程停在 blockout，不能称为完整质量验收通过。详情见该工作区 `final-report.json`、`README.md`。
- 该工作区现另有 `anatomy-correction` 生物学修正版：按正常成人外部解剖/右冠优势示例修正，知识检查与旧图像吻合验收分开。权威解剖关系优先于未标定插图细节；旧候选保存在 `output/anatomy-before/`，图像门槛失败历史不改写。最终知识审查见 `knowledge-review.md`。
- 此前在上述解剖修正版上完成 `surface-refinement`：连续对象空间材质、环境反射与曲面加密；解剖布局及冠脉源码保留，仍遵循有限外部解剖范围。对比和新证据见 `surface-review.md`、`output/material-final/`；材质优化不代表旧图像拟合门槛通过。

## 关键接口

- 当前最新心脏版本为 `reference-refinement`：结合四视图调整数值形体、展示截端和主动脉后伸，加入13条示意次级血管及贴面脂肪带。证据见 `workspaces/heart-multiview-retry/output/reference-final-03/` 与 `reference-refinement.md`。旧材质阶段“布局未变”是历史事实；四视图指标改善但仍未完成原图拟合验收。
- 最新验证为88项结构/区域标注、216组血管间距；新增支纳入固定身份清单。区域文字由实际末梢向内射线读取LV/RV表面检查，只验证模型与文字一致性。微法线高度源不得包含 `fwidth` 后再次求导，应与颜色抗锯齿分离。

- 工作流说明：`upstream/SKILL.md`
- 多视图规范与归一化：`upstream/docs/specs/reference-set.v1.schema.json`、`upstream/forge/_shared/reference_set.py`
- 多视图 state/intake：`upstream/forge/state.py`、`upstream/forge/stage1_intake/process_reference_set.py`
- Three.js 生成器：`upstream/forge/stage3_build/generate_threejs_factory.py`
- spec 校验：`upstream/forge/stage2_spec/validate_sculpt_spec.py`
- 多视图 review：`upstream/forge/stage4_review/make_multiview_comparison.py`、`upstream/forge/stage4_review/append_review.py`
- showcase 注册表：`showcase/src/demos/registry.ts`
- Crown Chest 工厂：`showcase/src/demos/crown-chest/createCrownChestModel.ts`
- 心脏重试：`workspaces/heart-reference-retry/src/createHeartModel.ts`、`src/heartMaterials.ts`、`anatomy-layout.json`；入口和运行说明见该工作区 `README.md`。
- 心脏工厂同步返回 Group，但调用方应等待 `root.userData.materialReady`；浏览器截图应等待 `window.__MODEL_READY__`。
- 多视图心脏采用 +Z 前方、+X 解剖左侧；left 相机位于 +X、right 位于 -X。四视图仅 vision-context，未标定相机。
- 生物学修正的冠脉工厂：`workspaces/heart-multiview-retry/src/coronaryAnatomy.ts`。`verify-anatomy.cjs <capture-stage>`、`verify-vessel-clearance.cjs <capture-stage>` 从实际浏览器几何检查连接/间距并绑定源码哈希；它们不能证明内部瓣膜、隔膜、管腔通畅性。左右心室是一个封闭外壳的两个语义面片区域。
- 多视图心脏 `heartMaterials.ts` 使用可克隆的 `MeshPhysicalMaterial` 子类，通过 `onBeforeCompile` 增加连续颜色/粗糙度/微法线细节。`surfaceDetail=0` 用于去细节诊断；应保留子类原型和独立参数。旧 `public/textures/*.png` 仅为归档资产，捕获报告中的 `materials.bitmapMaps` 才表示实际加载的贴图。

## 固定版本

- img2threejs `v1.5.1` / `dede5909be4e494b228c801a55dda47439143932`
- img2threejs-showcase / `a62ba87487e97a0c8cca90063bc0e85487e8894f`

## 验证约定

- Python 测试统一使用 Python 3.11、UTF-8 输出。
- `IMG2THREEJS_SHOWCASE_ROOT` 必须指向本目录的 `showcase/`。
- Windows 测试兼容补丁只触及测试启动器和路径解析；本地多视图扩展可修改 intake/spec/review 工作流，但不修改 Three.js generator 或 showcase 产品代码。
- `referenceSet.primaryViewId` 对应的 `path`/`camera` 必须分别镜像到旧字段 `sourceImage`/`referenceCamera`，以保持单图消费者兼容。
- 运行结果写入 `outputs/`；`node_modules`、`dist` 和 Playwright 会话不纳入版本控制。
