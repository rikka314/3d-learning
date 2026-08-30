# AI_CONTEXT.md

## TL;DR

- 这是 `3d-learning` 下的 img2threejs Windows 基线复现，不是新的独立产品仓库；当前快照含一个向后兼容的本地多视图 AI 工作流扩展。
- 上游源代码在 `upstream/`，官方可视化应用在 `showcase/`。
- 默认验证对象是 `workspaces/crown-chest/reference.png` 与 showcase 路由 `#/x/crown-chest`。
- 安装、验证、启动分别使用 `scripts/setup.ps1`、`scripts/verify.ps1`、`scripts/serve.ps1`。
- 不要把官方 Crown Chest showcase 结果表述为本地 agent 从零生成的结果。

## 关键接口

- 工作流说明：`upstream/SKILL.md`
- 多视图规范与归一化：`upstream/docs/specs/reference-set.v1.schema.json`、`upstream/forge/_shared/reference_set.py`
- 多视图 state/intake：`upstream/forge/state.py`、`upstream/forge/stage1_intake/process_reference_set.py`
- Three.js 生成器：`upstream/forge/stage3_build/generate_threejs_factory.py`
- spec 校验：`upstream/forge/stage2_spec/validate_sculpt_spec.py`
- 多视图 review：`upstream/forge/stage4_review/make_multiview_comparison.py`、`upstream/forge/stage4_review/append_review.py`
- showcase 注册表：`showcase/src/demos/registry.ts`
- Crown Chest 工厂：`showcase/src/demos/crown-chest/createCrownChestModel.ts`

## 固定版本

- img2threejs `v1.5.1` / `dede5909be4e494b228c801a55dda47439143932`
- img2threejs-showcase / `a62ba87487e97a0c8cca90063bc0e85487e8894f`

## 验证约定

- Python 测试统一使用 Python 3.11、UTF-8 输出。
- `IMG2THREEJS_SHOWCASE_ROOT` 必须指向本目录的 `showcase/`。
- Windows 测试兼容补丁只触及测试启动器和路径解析；本地多视图扩展可修改 intake/spec/review 工作流，但不修改 Three.js generator 或 showcase 产品代码。
- `referenceSet.primaryViewId` 对应的 `path`/`camera` 必须分别镜像到旧字段 `sourceImage`/`referenceCamera`，以保持单图消费者兼容。
- 运行结果写入 `outputs/`；`node_modules`、`dist` 和 Playwright 会话不纳入版本控制。
