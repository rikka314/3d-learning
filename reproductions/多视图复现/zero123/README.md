# Zero123++ v1.2 最小复现

## 原始项目与固定版本

- 官方代码：<https://github.com/SUDO-AI-3D/zero123plus>
- 本地源码：`upstream/`
- 固定 commit：`7d0315c31be6eb906b34cf07d91310f8e12e9b95`
- 模型：`sudo-ai/zero123plus-v1.2`
- 自定义 Diffusers pipeline：`sudo-ai/zero123plus-pipeline`
- 代码许可证：Apache-2.0；模型权重：CC-BY-NC-4.0，不可直接用于商业产品管线。

## 复现目标与完成标准

目标是从一张方形 RGB/RGBA 图像生成 Zero123++ v1.2 的固定 6 视图网格，作为标准教学器官、单细胞细胞核和细胞器多视图基线。

最小完成标准：

1. WSL2 中的隔离 `.venv` 能导入固定版本依赖并识别 CUDA GPU。
2. 模型权重只保存在 `checkpoints/`。
3. 对一张 `>=320x320` 的方形输入产生 6 视图 PNG，保存到 `outputs/`，日志保存到 `logs/`。
4. 固定 seed 和推理步数，记录输入来源与许可证，便于后续三类医学对象的横向比较。

## 环境、依赖与硬件

- 首选运行方式：Windows 11 + WSL2 Ubuntu 24.04。
- 目标 GPU：NVIDIA RTX 5070 12GB。官方基础推理约需 5GB VRAM，12GB 可运行 RGB-only 基线。
- Python：由项目内 `uv 0.8.13` 管理的 CPython 3.11.13。
- CUDA 轮子：PyTorch 2.7.1 + cu128，用于 RTX 50 系 Blackwell。
- 完整锁文件：`uv.lock`；顶层约束：`pyproject.toml`。
- setup 校验 uv 0.8.13 官方归档 SHA-256，并在 fresh clone 时自动拉取/核对固定的上游 commit。
- 模型和可执行 custom pipeline 分别按上述 commit 解析为本地 snapshot；推理只从固定的本地 `pipeline.py` 动态导入，不执行 Hugging Face `main` 上的可变代码。

所有复现状态均收口在本目录：

| 内容 | 位置 |
| --- | --- |
| Python 环境 | `.venv/` |
| `uv` 及 Python 安装 | `.tools/uv/`、`cache/uv-python/` |
| Hugging Face 模型 | `checkpoints/huggingface/` |
| 输入 | `inputs/` |
| 生成结果 | `outputs/` |
| 运行日志 | `logs/` |
| 其他缓存与临时文件 | `cache/` |

## 数据与运行命令

在 PowerShell 中：

```powershell
cd "D:\Learn\20_Projects\3dresearch\3d-learning\reproductions\多视图复现\zero123"
.\setup.ps1
.\download_weights.ps1
.\run.ps1 -Input ".\inputs\organ.png" -Steps 28 -Seed 42 -Offline
```

下载后可在 WSL 内做不执行去噪的离线模型装载 smoke：

```bash
./.venv/bin/python ./scripts/smoke_model_load.py
```

若显存紧张：

```powershell
.\run.ps1 -Input ".\inputs\organ.png" -Steps 28 -Seed 42 -CpuOffload -Offline
```

输入应为单一对象、方形画布、主体居中，建议分辨率不低于 320x320。医学资产必须另行记录来源、许可证、解剖审核状态；此生成结果不应被视为患者特异或解剖真值。

## 相机约定

v1.2 输出相对方位角为 `30, 90, 150, 210, 270, 330`，绝对仰角为 `20, -10, 20, -10, 20, -10`，统一视场角为 30°。它输出的是单张 2x3 视图网格，不是 3D 网格；后续需与几何重建方法串联。

## 当前状态、结果与问题

- 官方源码已拉取并固定 commit。
- 2026-08-25：项目内 `uv 0.8.13` + Python 3.11.13 + `.venv` 已安装完成，`uv sync --frozen` 审计 46 个包通过。
- CUDA doctor 通过：PyTorch `2.7.1+cu128`、Torchvision `0.22.1+cu128`、CUDA runtime 12.8，识别 `NVIDIA GeForce RTX 5070`；CUDA 计算能力 `(12, 0)` 的矩阵核实测通过。
- 权重已下载：基础模型 snapshot `2da07e89919e1a130c9b5add1584c70c7aa065fd`，pipeline snapshot `983e66d28a3637ddd8e3e2fd8165cdff32230872`。离线 pipeline 装载 smoke 通过。
- 1 步 GPU smoke 通过：官方 README 示例输入 `inputs/official-lysol.png` 产生 `outputs/official-lysol_s42_n1.png`（640x960 的 2x3 视图网格），完整运行日志为 `logs/inference-20260825-235243.log`。1 步结果只用于验证代码路径，不用于评估生成质量。
- 28 步正式基线通过：同一输入与 seed 42 产生 `outputs/official-lysol_s42_n28.png`（640x960，6 个视图），去噪阶段约 6.5 秒；完整日志为 `logs/inference-20260825-235551.log`。已人工打开检查，视角变化与主体轮廓清晰。
- 固定本地 snapshot 加载复测通过：`outputs/official-lysol_s42_n28_pinned.png` 使用相同 seed/28 步成功输出，证明模型与 custom pipeline 均无需访问可变的远程 `main`。
- 官方 `requirements.txt` 未锁定 PyTorch/Hugging Face Hub，且包含 UI、SAM 和背景移除的非必需依赖；本复现仅锁定 RGB-only 推理必需集合。
- 本模型的视图一致性不等于医学结构正确性，标准教学器官/细胞器结果需由可验证几何或专家审核约束。
