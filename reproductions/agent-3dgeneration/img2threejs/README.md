# img2threejs 本地复现

状态：**基线复现完成，并加入本地多视图工作流扩展**。已在 Windows 上锁定上游版本、安装官方 showcase、通过生产构建和上游测试，并用真实浏览器打开 Crowned Loot Chest 示例。当前本地工作流既接受单图，也接受带稳定 `viewId` 的多图 `ReferenceSet`。

> img2threejs 不是“上传图片后一次推理直接输出模型”的传统模型。它是一套面向 coding agent 的工作流：分析参考图，编写结构化 sculpt spec，生成 Three.js 程序化几何，再经浏览器渲染和视觉门禁迭代。

> 这里的“多视图”是 AI 工作流层的多证据融合：逐图 intake、统一 spec、按视角配对渲染和逐视角门禁。它不是 COLMAP/NeRF/MVS，也不会仅凭多张未标定图片自动求解精确网格。

## 复现目标与成功标准

- 固定可追踪的 img2threejs 与 showcase 源码版本。
- Windows 本地可以安装依赖、执行完整测试、构建前端。
- 浏览器可以加载官方单图重建示例，并且控制台无错误。
- 保留参考图、构建日志、测试日志和截图，便于后续横向比较 Blender MCP 与 UE5 MCP。

## 已完成结果

- img2threejs：`v1.5.1`，commit `dede5909be4e494b228c801a55dda47439143932`。
- img2threejs-showcase：commit `a62ba87487e97a0c8cca90063bc0e85487e8894f`。
- showcase：TypeScript 检查和 Vite production build 通过。
- 上游测试：`1112` 项运行完成并通过；`4` 项因上游未随仓库发布的历史截图或 rig gate 脚本而跳过。
- Playwright 浏览器验证：Crowned Loot Chest 页面正常渲染，console `0 errors / 0 warnings`。
- 视觉证据：[Crown Chest 浏览器截图](outputs/screenshots/crown-chest-showcase.png)。
- 本地多视图扩展：`ReferenceSet v1`、逐视图 intake、assessment/spec 透传、camera-aware 校验、matched-view comparison/review；旧 `--reference <image>` 与单图 spec 保持兼容。

## 目录

```text
img2threejs/
├─ upstream/                 # img2threejs v1.5.1 源码快照
├─ showcase/                 # 官方 showcase 固定提交
├─ workspaces/crown-chest/   # 本次选用的公开参考图
├─ outputs/
│  ├─ logs/                  # 测试与构建日志
│  └─ screenshots/           # 浏览器复现截图
├─ scripts/                  # 一键安装、验证和启动脚本
├─ SOURCE_LOCKS.md           # 上游版本锁定
└─ LOCAL_PATCHES.md          # Windows 兼容与本地多视图扩展说明
```

## 环境

本次验证环境：

- Windows / PowerShell
- Python `3.11.15`（由 `uv` 管理）
- Node.js `24.18.0`
- npm `11.17.0`

需要预先安装：Git、Node.js/npm、uv。

## 快速运行

```powershell
Set-Location 'D:\Learn\20_Projects\3dresearch\3d-learning\reproductions\agent-3dgeneration\img2threejs'

.\scripts\setup.ps1
.\scripts\verify.ps1
.\scripts\serve.ps1
```

启动后访问：

```text
http://127.0.0.1:4173/#/x/crown-chest
```

`verify.ps1` 会先构建 showcase，再运行 img2threejs 的完整 Python 测试套件。日志写入 `outputs/logs/`。

## 当前复现边界

这次完成的是“项目可运行 + 官方高质量样例可呈现”的基线复现，以及一层可执行的多视图 AI 工作流。Crown Chest 模型代码来自固定版本的官方 showcase，不应被描述成我们从零重新拟合出的结果。多视图扩展没有改写 Three.js generator，也没有新增摄影测量或神经重建求解器。

下一阶段若要测试真实能力，应提供统一的自有参考图，让 img2threejs、Blender MCP、UE5 MCP 使用相同输入、时间预算和评分表，比较：轮廓相似度、材质观感、可编辑性、生成耗时与人工介入次数。

## 许可提示

`upstream/` 保留了原项目的 `LICENSE`。固定的 showcase 快照中未发现独立 `LICENSE` 文件；如需对外分发或商用，请再次确认其仓库许可与素材授权。
