# basic-cube 端到端 case

目标：在 Blender addon 与固定版本 MCP server 建立连接后，完成最小可验证操作。

成功标准：

1. 调用 `get_scene_info` 读取初始场景；
2. 创建一个命名明确的基础几何体并设置材质；
3. 再次调用 `get_scene_info`，确认对象、位置和材质；
4. 保存 `.blend` 并导出 `.glb` 到本目录的 `output/`；
5. 把 viewport 或 render 截图保存到项目级 `outputs/screenshots/`；
6. 记录使用的 prompt、耗时、人工介入次数和异常。

当前状态：Blender 4.5.13 LTS 与固定 addon 已安装并通过后台加载 smoke test；等待在 Blender GUI 中启用 addon、启动 server 后执行。`output/` 已由顶层 `.gitignore` 忽略，选定的最终证据应复制到项目级 `outputs/`。
