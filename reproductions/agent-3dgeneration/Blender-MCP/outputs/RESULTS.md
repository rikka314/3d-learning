# 复现结果

验证日期：2026-08-27。

## 自动验证

| 验证项 | 结果 | 证据 |
| --- | --- | --- |
| `uv.lock` 一致性 | 通过 | `logs/lock-check.txt` |
| 上游 `tests/` | `32 passed` | `logs/pytest-tests.txt` |
| 根目录 bbox 参数化测试 | `2 passed` | `logs/pytest-root-bbox.txt` |
| sdist / wheel 构建 | 通过 | `logs/build.txt` |
| CLI 帮助入口 | 通过 | `logs/cli-help.txt` |
| MCP stdio initialize / list-tools | 通过 | `logs/mcp-stdio-smoke.txt`、`logs/mcp-stdio-smoke.stderr.txt` |
| Blender 版本检查 | `4.5.13 LTS` | `logs/blender-version.txt` |
| 固定 addon 后台加载 | register / unregister 通过 | `logs/blender-addon-smoke.txt` |

## 已确认版本

- Blender-MCP commit：`50a37a0dcf9898d86044398295d5097eab8ffa6b`
- Python：`3.11.15`
- uv：`0.12.1`
- 上游包：`blender-mcp 1.8.7`
- Blender：`4.5.13 LTS`，安装路径 `E:\Apps\Blender\4.5.13`
- Addon：`E:\Apps\Blender\4.5.13\4.5\scripts\addons\blender_mcp.py`
- Addon SHA-256：`509142C8404A72654DF1F9E52DC701D5EEC8F75B773A0DF7C67E76F6EE938506`

## 未完成验证

以下 GUI / 场景级项目尚未执行：

- 在 Blender GUI 中启用 addon 并启动 server；
- MCP server 到 Blender addon 的 TCP 握手；
- `get_scene_info`；
- 创建基础几何体；
- 保存 `.blend`、导出 `.glb`；
- viewport / render 截图。

这些项目属于 `workspaces/basic-cube/` 的下一阶段端到端验证，不影响当前 Python package、MCP stdio server、Blender 安装和 addon 加载基线结论。
