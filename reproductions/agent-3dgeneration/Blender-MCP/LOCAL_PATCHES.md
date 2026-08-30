# Local patches

## 上游源码

没有修改 `upstream/` 中的生产代码、测试或依赖锁文件。

上游 `.gitignore` 包含 `/test_*.py`，同时上游 Git 又追踪根目录的 `test_process_bbox_validation.py`。移除嵌套 `.git` 后，父仓普通 `git add` 会误忽略这个上游文件。为确保源码快照完整，本地只在 `upstream/.gitignore` 增加：

```gitignore
!/test_process_bbox_validation.py
```

这条规则不改变运行逻辑，只恢复上游已跟踪测试文件在父仓中的可见性。

## Windows 验证环境

上游 `tests/test_trajectory_size_guard.py` 使用 `Path.read_text()` 读取 UTF-8 的 `addon.py`，但没有显式传入 encoding。中文 Windows 默认 GBK 环境下会触发 `UnicodeDecodeError`。

本地 `scripts/verify.ps1` 在测试进程中设置：

```text
PYTHONUTF8=1
PYTHONIOENCODING=utf-8
```

这只改变测试进程的编码模式，不改写上游测试或产品实现。

本地脚本还默认设置 `DISABLE_TELEMETRY=true`，避免基线验证产生上游遥测；需要时可以显式开启。脚本退出时会恢复调用进程原有环境变量。
