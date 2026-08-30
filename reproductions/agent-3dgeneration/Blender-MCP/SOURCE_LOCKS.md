# Source locks

检出日期：2026-08-27。

| 组件 | 上游 | 固定版本 | 本地目录 |
| --- | --- | --- | --- |
| Blender-MCP | https://github.com/ahujasid/blender-mcp | commit `50a37a0dcf9898d86044398295d5097eab8ffa6b` | `upstream/` |

补充信息：

- 上游分支：`main`。
- 上游包版本：`1.8.7`。
- 固定提交时间：`2026-08-26T13:09:44+05:30`。
- 固定提交说明：`docs: update README`。
- 检出时上游没有 tag 指向该提交，也没有可用 Git tag；因此以完整 SHA 作为唯一版本锁。
- `upstream/` 的嵌套 `.git` 已移出到被忽略的 `.runtime/upstream-git/`，不会形成嵌套仓库；源码由父级 `3d-learning` 仓库统一追踪。
- 上游生产代码、测试和依赖锁未修改；仅在上游 `.gitignore` 增加一条反忽略规则，确保父仓能够追踪上游本来已跟踪的根目录测试文件，详见 `LOCAL_PATCHES.md`。

## 验证工具链锁定

| 工具 | 固定版本 |
| --- | --- |
| uv | `0.12.1` |
| Python | `3.11`（本次解析为 `3.11.15`） |
| pytest | `9.1.1` |
| setuptools | `80.9.0` |
| wheel | `0.45.1` |

`setuptools` 和 `wheel` 的构建约束保存在 `build-constraints.txt`。
