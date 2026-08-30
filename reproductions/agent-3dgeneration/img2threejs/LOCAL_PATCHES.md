# Local patches

## Windows 测试启动兼容

上游测试按 Unix 可执行文件规则直接启动 `npx` 和 `node_modules/.bin/esbuild`。Windows 的实际入口分别是 `npx.cmd` 和 `esbuild.cmd`，因此原样运行会出现 `WinError 2` 或 `WinError 193`。

这组兼容补丁只修改 `upstream/forge/tests/`：

- 在 `showcase_test_support.py` 增加 `npx_command()` 与 `node_bin()`，按平台解析命令入口。
- 将 8 个 TypeScript 编译测试改为使用 `npx_command()`。
- 将 SDF 与 tapered-sweep 的 esbuild 测试改为使用 `node_bin()`。
- 将 3 个硬编码 `../img2threejs-showcase` 的测试改为读取 `IMG2THREEJS_SHOWCASE_ROOT`。

## 多视图 AI 工作流扩展

在固定的 `v1.5.1` 源码快照上增加了一个向后兼容的 `ReferenceSet v1`：

- `_shared/reference_set.py` 归一化单图、重复 `--reference [viewId=]path` 或 JSON manifest，校验主视图、重复路径/内容哈希，并写入稳定 sidecar。
- `state.py` 与 `_shared/workflow_state.py` 在保留旧 `artifacts.reference` 的同时记录 `artifacts.referenceSet`，并把后续 intake/spec 命令路由到同一份 manifest。
- `stage1_intake/process_reference_set.py` 对每个视图运行技术探测和 admission，输出逐视图证据与汇总状态。
- `new_pre_spec_assessment.py`、`new_sculpt_spec.py` 和 `validate_sculpt_spec.py` 透传并校验多视图；`camera-aware` 模式要求每个视图有有效相机元数据。
- `make_multiview_comparison.py` 按 `viewId` 严格配对 reference/render；`append_review.py` 记录 `viewReviews[]`，所有 critical 视图（未声明 critical 时为全部视图）必须达到阈值才能 `continue`。
- 新增的多视图测试覆盖 manifest、state、intake、assessment/spec、兼容字段和 review 门禁。

保持不变：

- `forge/stage3_build/generate_threejs_factory.py` 的 Three.js 代码生成逻辑。
- `showcase/src/` 的模型、渲染和交互代码。
- Crown Chest 参考图或模型实现。

因此，该扩展是“多视图证据驱动的 AI 工作流”，不是摄影测量、NeRF 或自动 MVS 网格求解器。
