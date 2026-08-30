# Blender-MCP 复现上下文

## 项目定位

- 上游：`https://github.com/ahujasid/blender-mcp`
- 本地目标：固定源码版本，验证 Python 包、MCP stdio 握手和 Blender addon 安装入口，为后续真实 Blender 场景生成建立基线。
- 当前固定提交：`50a37a0dcf9898d86044398295d5097eab8ffa6b`
- 上游包版本：`1.8.7`

## 目录入口

- `README.md`：复现状态、运行方式和边界。
- `SOURCE_LOCKS.md`：上游版本锁定。
- `LOCAL_PATCHES.md`：Windows 本地兼容说明。
- `upstream/`：移除嵌套 `.git` 后的上游源码快照。
- `scripts/setup.ps1`：以 Python 3.11 安装锁定依赖。
- `scripts/verify.ps1`：运行测试、构建、CLI 与 MCP stdio smoke test。
- `scripts/install-addon.ps1`：把固定快照中的 addon 安装到 Blender。
- `scripts/server.ps1`：从固定快照启动 stdio MCP server。
- `outputs/RESULTS.md`：验证证据索引。
- `workspaces/basic-cube/`：下一阶段 Blender 端到端最小场景。

## 关键运行事实

- MCP server 通过 stdio 与客户端通信，再通过 TCP JSON 连接 Blender addon；默认目标为 `localhost:9876`。
- 自动测试不需要 Blender；真实场景创建、截图和 `.blend/.glb` 输出需要 Blender 3.0+。
- Windows 验证必须设置 `PYTHONUTF8=1`，否则一个上游测试会用 GBK 读取 UTF-8 `addon.py` 并失败。
- 遥测默认由上游开启；本地脚本默认设置 `DISABLE_TELEMETRY=true`。
- 不要同时让多个 MCP client 使用同一个 Blender addon 端口。
- Blender `4.5.13 LTS` 便携版安装在 `E:\Apps\Blender\4.5.13`；固定快照 addon 安装在 `4.5\scripts\addons\blender_mcp.py`。

## 当前边界

- 已完成源码、依赖、测试、构建、CLI 和 MCP stdio 层基线。
- Blender 版本检查和 addon 后台加载 smoke test 已通过。
- Blender GUI 中启动 addon server、MCP TCP 握手和真实建模 smoke test 尚未执行。
- 后续端到端最小 case：连接 Blender，创建基础几何体，复查 scene info，并保存 `.blend`、导出 `.glb`、保留截图。
