# MV-Adapter 最小复现

## 来源与固定版本

- 官方代码：<https://github.com/huanngzh/MV-Adapter>
- 论文：*MV-Adapter: Multi-view Consistent Image Generation Made Easy*（ICCV 2025）
- 模型权重：<https://huggingface.co/huanngzh/mv-adapter>
- 上游提交：`4277e0018232bac82bb2c103caf0893cedb711be`（2025-06-26）
- MV-Adapter 权重快照：`6de4033df6b53366f3c009d22f5ec434bb55e59f`
- SD2.1-base 公开镜像快照：`sd2-community/stable-diffusion-2-1-base@4e63672c03103b6c636b8fb4119ba982469b2955`
- 代码与 MV-Adapter 权重许可证：Apache-2.0。
- SD2.1-base 镜像许可证：CreativeML Open RAIL++-M；生成和分发仍受该许可证的 use-based restrictions 约束。镜像模型卡标识为 `openrail++`，并链接完整许可证文本。

`upstream/` 保留官方源码和 Git 历史，`UPSTREAM_COMMIT` 记录本次复现的精确提交。

## 复现目标与完成标准

本目录先复现两条 6-view 路线：

1. `i2mv`：单张教学器官/细胞参考图 → 6 视图。
2. `ig2mv`：单张参考图 + 已验证几何 → 受几何约束的 6 视图，作为后续 3D 重建/贴图的主路线。

最小完成标准：

- WSL2 环境安装可重复，环境、缓存、权重和结果都在本目录。
- `smoke_import.py` 可导入 SD2.1 image-to-multiview pipeline 并识别 RTX 5070。
- `i2mv` 生成一张 6 视图网格图到 `outputs/`。
- `ig2mv` 在 CUDA toolkit / `nvdiffrast` 就绪后，生成 RGB、position 和 normal 网格图。

## 环境与显存决策

- 验证目标：Windows 11 + WSL2 Ubuntu 24.04 + RTX 5070 12GB。
- Python 3.10.18 由本地 `uv` 管理，环境位于 `.venv/`。
- `requirements-inference.txt` 保存直接约束；`requirements-lock.txt` 是 uv 生成的 73 包完整锁并包含文件哈希，setup 使用 `pip sync --require-hashes`。
- 上游以固定目录加入 `PYTHONPATH`，不安装其包含 UI/geometry 全量依赖声明的 editable wheel；因此 `pip check` 可严格验证本轮 i2mv 环境，而 `open3d`、`pymeshlab`、`cvcuda` 等留在独立 geometry 环境阶段。
- RTX 5070 需要 Blackwell / CUDA 12.8 支持，因此固定 `torch==2.7.1` + `torchvision==0.22.1` 的 `cu128` wheels，不采用官方 README 中面向旧显卡的 `cu118` 示例。
- 官方说明 SDXL image-to-multiview 约需 14GB VRAM，高于本机 12GB；默认使用 512px SD2.1 版本和 `DDPM` scheduler。
- 官方 SD2.1 脚本已启用 VAE slicing。上游未提供 CPU offload CLI 开关，因此本骨架不对 pipeline 做未验证的 monkey patch。
- 2026-08-26 匿名访问上游脚本默认的 `stabilityai/stable-diffusion-2-1-base` 返回 HTTP 401；本复现改用公开的同名 SD2.1-base community mirror，并将实际快照固定在上方。
- setup 按固定 revision 下载最小 SD2.1 文件集和 i2mv/ig2mv SD2.1 adapter；运行时只向上游脚本传本地 snapshot 路径，不跟随 Hugging Face `main`。
- `ig2mv` 需要 `nvdiffrast` 和与 PyTorch CUDA 12.8 匹配的 WSL CUDA toolkit（`nvcc`）。驱动可见不等于 toolkit 已安装。

## Camera-only optional dependency patch

官方 `i2mv` 的 camera 路径本身不使用 rasterizer，但 `mesh_utils` 的 eager import 会间接要求 `nvdiffrast`。本目录通过 `patches/i2mv-optional-nvdiffrast.patch` 做最小修复：camera exports 立即可用，geometry/rasterization exports 延迟加载，并在缺少 `nvdiffrast` 时抛出明确错误。`scripts/setup_wsl.sh` 会幂等应用并验证该 patch，不会静默改变固定的上游来源。

回归测试：

```powershell
wsl -d Ubuntu-24.04 -- bash -lc 'cd "/mnt/d/Learn/20_Projects/3dresearch/3d-learning/reproductions/多视图复现/mv-adapter" && PYTHONPATH=upstream .venv/bin/python tests/test_optional_nvdiffrast.py'
```

未安装 geometry 依赖时，预期输出为 `camera_import=ok` 和 `geometry_optional_dependency_error=ok`；安装 `nvdiffrast` 后，同一测试改为验证 geometry export 可导入。当前任务没有安装或运行 geometry/`ig2mv` 依赖。

注意：上游 `setup.py` 把 inference、training、geometry 和 texturing 依赖全部列为强依赖；本目录有意使用 inference-only 环境，因此通用 `uv pip check` 会报告未安装 `open3d`、`pymeshlab`、`cvcuda-cu12` 等非 i2mv 包。这里以 import regression 和实际 i2mv 端到端运行作为环境验证，不为消除 metadata 警告安装 geometry stack。

## 目录约定

```text
mv-adapter/
├── .venv/             # WSL Python 环境（忽略）
├── .tools/            # uv bootstrap 和受管 Python（忽略）
├── cache/             # HF / Torch / uv / pip 缓存（忽略）
├── checkpoints/       # 手动权重（忽略）
├── inputs/            # 医学输入图和已验证 mesh（忽略）
├── logs/              # 安装/运行日志（忽略）
├── outputs/           # 生成结果（忽略）
├── scripts/           # PowerShell / WSL 入口
└── upstream/          # 固定的官方代码
```

## 安装与验证

在 PowerShell 中：

```powershell
cd D:\Learn\20_Projects\3dresearch\3d-learning\reproductions\多视图复现\mv-adapter
.\scripts\setup.ps1
```

该脚本会创建本地 `.venv`，安装固定的 CUDA 12.8 PyTorch 与 inference-only 依赖，以 editable/no-deps 方式挂载上游源码，最后写入 `logs/import-smoke.log`。

仅重跑导入验证：

```powershell
wsl -d Ubuntu-24.04 -- bash -lc 'cd "/mnt/d/Learn/20_Projects/3dresearch/3d-learning/reproductions/多视图复现/mv-adapter" && PYTHONPATH=upstream .venv/bin/python scripts/smoke_import.py'
```

## 运行

低显存 `i2mv` 默认测试（首次会下载 SD2.1、MV-Adapter 权重，占用数 GB）：

```powershell
.\scripts\run.ps1 -Mode i2mv -Steps 50 -Seed 0
```

带显存、耗时记录的 WSL benchmark：

```powershell
wsl -d Ubuntu-24.04 -- bash -lc 'cd "/mnt/d/Learn/20_Projects/3dresearch/3d-learning/reproductions/多视图复现/mv-adapter" && bash scripts/benchmark_wsl.sh --tag i2mv-sd21-seed0-50step --steps 50 --seed 0 --offline'
```

医学输入应放在 `inputs/`，并用本目录相对路径：

```powershell
.\scripts\run.ps1 -Mode i2mv `
  -Image inputs/teaching-heart.png `
  -Output outputs/teaching-heart-sd21.png `
  -Prompt "high quality anatomical teaching model of a human heart"
```

几何条件路线（需先安装 CUDA toolkit 和 `requirements-geometry.txt`）：

```powershell
.\scripts\run.ps1 -Mode ig2mv `
  -Image inputs/teaching-heart.png `
  -Mesh inputs/teaching-heart.glb `
  -Output outputs/teaching-heart-geometry-sd21.png
```

输入 mesh 的朝向必须与官方 `upstream/assets/demo/ig2mv/` 示例一致，否则需同步调整渲染相机角度。

## 当前状态

- 已完成：上游源码固定、目录隔离、CUDA 12.8 环境、optional dependency 回归、官方 i2mv 示例的 1-step smoke、50-step 正式推理和 offline cache 复跑。
- 已完成：Python 3.10.18、73 包哈希锁、uv release SHA-256 校验，以及 base/adapter 固定本地 snapshot 路径。
- 未运行 `ig2mv`。当前 WSL 未检测到 `nvcc`，本轮不构建 `nvdiffrast`。

## RTX 5070 实测结果

测试输入为官方 `upstream/assets/demo/i2mv/A_decorative_figurine_of_a_young_anime-style_girl.png`，prompt 为 `A decorative figurine of a young anime-style girl`，固定 `seed=0`、6 views、512×512/view、DDPM。

| Run | Offline | 总耗时 | 峰值总显存 | 相对 baseline | 输出 |
|---|---:|---:|---:|---:|---|
| 1-step（首次下载） | 否 | 389.25 s | 10,129 MiB | +7,200 MiB | `outputs/i2mv-sd21-community-smoke-1step.png` |
| 50-step | 是 | 122.65 s | 10,233 MiB | +7,220 MiB | `outputs/i2mv-sd21-community-seed0-50step.png` |
| 1-step cache rerun | 是 | 101.14 s | 10,181 MiB | +7,180 MiB | `outputs/i2mv-sd21-community-offline-1step.png` |
| 1-step pinned local rerun | 是 | 112.55 s | 9,323 MiB | +7,362 MiB | `outputs/i2mv-pinned-local-offline-1step.png` |

四个网格均为 `3072×512 RGB`，即横向 6 个 `512×512` 视图。50-step SHA-256：`f18759772e2be2a12fc5ed92b68794dd1d8dcad468918337c119c6c3d2d3d9f9`。online、cache offline 与固定本地 snapshot 三次 1-step 输出逐字节一致，SHA-256 均为 `744ce212cffeb6b8bdfe6f43b6d75eb4670d41464a01b2e4652e4907d46b36ea`。

详细 stdout、`nvidia-smi` 250 ms 采样和 `/usr/bin/time` 数据位于 `logs/<tag>.*`；Hugging Face 缓存当前约 5.5 GiB，全部位于本目录 `cache/huggingface/`。
