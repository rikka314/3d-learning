# Blender-MCP 本地复现

状态：**源码、MCP server、Blender 4.5.13 LTS 和 addon 加载基线复现完成；GUI 端到端建模验证待补。**

本目录固定复现 [`ahujasid/blender-mcp`](https://github.com/ahujasid/blender-mcp)。它不是独立的 3D 生成模型，而是一座桥：MCP client 通过 Python server 把命令转发给 Blender addon，由 addon 在 Blender 主线程中执行 `bpy` 操作。

## 当前结果

- 固定上游 `main` commit：`50a37a0dcf9898d86044398295d5097eab8ffa6b`。
- 上游包版本：`blender-mcp 1.8.7`；许可：MIT。
- Python `3.11.15` + `uv 0.12.1` 依赖安装成功。
- 上游标准测试：`32 passed`。
- 根目录额外 bbox 测试：`2 passed`；该文件不在上游默认 `testpaths` 内，所以单独执行。
- sdist / wheel 构建成功。
- `blender-mcp --help` 与真实 MCP stdio initialize/list-tools 握手通过。
- Blender `4.5.13 LTS` 便携版已安装到 `E:\Apps\Blender\4.5.13`。
- 固定快照的 addon 已安装到该版本的 `4.5\scripts\addons\blender_mcp.py`，SHA-256 与源码副本一致；Blender 后台 import/register/unregister smoke test 通过。
- GUI 中启动 addon server、场景生成、截图和 `.blend/.glb` 输出尚未执行。

验证详情见 [`outputs/RESULTS.md`](outputs/RESULTS.md)。

## 目录

```text
Blender-MCP/
├─ upstream/                 # 固定上游源码快照
├─ scripts/
│  ├─ setup.ps1             # 安装锁定依赖
│  ├─ verify.ps1            # 测试、构建与 MCP stdio smoke test
│  ├─ install-addon.ps1     # 安装固定版本 addon
│  ├─ server.ps1            # 启动固定版本 stdio MCP server
│  └─ mcp_smoke.py          # MCP client 握手验证
├─ outputs/
│  ├─ logs/                 # 自动验证日志
│  ├─ screenshots/          # 后续 Blender 视觉证据
│  └─ RESULTS.md            # 结果摘要
├─ workspaces/basic-cube/   # 后续 Blender 端到端最小 case
├─ build-constraints.txt    # 固定 setuptools / wheel
├─ SOURCE_LOCKS.md
├─ LOCAL_PATCHES.md
└─ AI_CONTEXT.md
```

## 环境

本次验证环境：

- Windows / PowerShell
- Python `3.11.15`（由 `uv` 管理）
- `uv 0.12.1`
- Blender `4.5.13 LTS`：`E:\Apps\Blender\4.5.13\blender.exe`

上游运行要求：Blender 3.0+、Python 3.10+、`uv`。本地脚本固定使用 Python 3.11，避免 conda、pyenv 或较新 Python 版本造成依赖解析差异。

## 快速验证

```powershell
Set-Location 'D:\Learn\20_Projects\3dresearch\3d-learning\reproductions\agent-3dgeneration\Blender-MCP'

.\scripts\setup.ps1
.\scripts\verify.ps1
```

验证脚本会执行：

1. 检查 `uv.lock`；
2. 运行 `tests/` 下的 32 项测试；
3. 单独运行根目录 bbox 参数化测试；
4. 构建 sdist 和 wheel；
5. 检查 CLI；
6. 通过 MCP SDK 真正启动本地 stdio server，完成 initialize 和 list-tools。

日志写入 `outputs/logs/`。

## Blender 与 addon

当前已安装：

```text
Blender: E:\Apps\Blender\4.5.13\blender.exe
Addon:   E:\Apps\Blender\4.5.13\4.5\scripts\addons\blender_mcp.py
```

需要重新安装 addon 时执行：

```powershell
.\scripts\install-addon.ps1
```

本次使用的明确目录为：

```powershell
.\scripts\install-addon.ps1 -AddonsDir 'E:\Apps\Blender\4.5.13\4.5\scripts\addons'
```

然后在 Blender 中：

1. 打开 `Edit → Preferences → Add-ons`；
2. 启用 `Interface: Blender MCP`；
3. 在 3D View 按 `N`，打开 `BlenderMCP`；
4. 点击启动 MCP server。

## MCP client 启动方式

MCP client 应直接启动固定快照，而不是使用会随上游更新的裸 `uvx blender-mcp`：

```text
command: uv
args:
  --directory
  D:\Learn\20_Projects\3dresearch\3d-learning\reproductions\agent-3dgeneration\Blender-MCP\upstream
  run
  blender-mcp
```

Windows GUI 客户端若找不到 `uv`，先运行 `where uv`，把 `command` 改成绝对 `uv.exe` 路径。建议同时设置：

```text
DISABLE_TELEMETRY=true
BLENDER_HOST=localhost
BLENDER_PORT=9876
PYTHONUTF8=1
```

手动执行 `.\scripts\server.ps1` 后进程等待 stdio 输入是正常行为；通常应由 MCP client 启动它。

## 安全与复现边界

- `execute_blender_code` 可以在 Blender 内执行任意 Python；操作前先保存 `.blend`。
- Poly Haven、Sketchfab、Hyper3D 和 Hunyuan3D 属于可选外部能力，可能需要网络或 API key，本次基线没有启用。
- 本地脚本默认关闭上游遥测；如需开启，显式传入 `-EnableTelemetry`。
- 当前完成的是 server/package 基线，不应描述成已经通过 Blender MCP 从零生成了 3D 资产。
