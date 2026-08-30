# Era3D 最小复现

## 定位与成功标准

本目录复现 Era3D 的第一阶段：将单张前景隔离的 RGBA 图像生成 6 个固定视角的 RGB 图和法线图。这一阶段用于比较标准教学器官、单细胞细胞核和细胞器的多视图一致性。

最小复现成功需同时满足：

1. `scripts/smoke.ps1` 证明 PyTorch CUDA wheel 包含 `sm_120` 且 Era3D 数据集与 pipeline 可导入。
2. 每张 RGBA 输入在 `outputs/<run-id>/<case>/` 生成 6 张 `color_*` 和 6 张 `normals_*` 图像。
3. 运行日志和完整依赖快照留在本目录 `logs/` 内。

本阶段不包含 Instant-NSR 网格重建；后者需额外编译 `tiny-cuda-nn` 和 `nvdiffrast`，不应与多视图基线的可用性混在一次环境验证中。

## 上游与许可证

- 论文：*Era3D: High-Resolution Multiview Diffusion using Efficient Row-wise Attention* (NeurIPS 2024)
- 代码：<https://github.com/pengHTYX/Era3D>
- 本地源码：`upstream/`
- 固定 commit：`a2ce68da53c0dc4df403112c53692b9ba893a4f0`
- 标准权重：`pengHTYX/MacLab-Era3D-512-6view` @ `00732de5cb3417b2a806ced9e92879aacb67c731`
- 正交权重：`pengHTYX/MacLab-Era3D-512-6view-ortho` @ `ecd72f13232c5ca5ae4e9b927d8917c9bc079886`
- 许可证：AGPL-3.0，见 `upstream/LICENCE`。官方 README 明确要求包含其代码或预训练模型的下游方案按 AGPL 条件开源；不应将本复现直接并入闭源产品。

## 环境决策：RTX 5070 / Blackwell

官方环境固定 Python 3.9、PyTorch 2.1.2 + CUDA 11.8、torchvision 0.16.2 和 xFormers 0.0.23.post1。该 PyTorch wheel 早于 Blackwell，不包含 RTX 5070 的 `sm_120` 内核。

本复现使用最小兼容组合：

- Windows 11 主机 + WSL2 Ubuntu 24.04；
- 本目录内的 uv 0.12.1、uv 管理的 Python 3.11.13 和 `.venv/`；
- PyTorch 2.7.0 + CUDA 12.8、torchvision 0.22.0，不安装 xFormers；
- 保留 Era3D 依赖的 Diffusers 0.26.0 / Transformers 4.37.2 API 组合。

`requirements-inference.txt` 记录人工选择的直接依赖，`requirements-lock.txt` 锁定 76 个完整依赖及哈希；安装脚本使用后者并强制哈希校验。

PyTorch 2.7/cu128 是支持 Blackwell 的稳定基线。PyTorch 官方 cu128 索引中与该 torch 线匹配的 xFormers 0.0.30 wheel 虽然可导入，但在 RTX 5070 执行 attention 时实测报 `no kernel image is available for execution on the device`，即该 wheel 没有 `sm_120` 内核。本机无 nvcc，因此不现场编译 xFormers。

`scripts/inference_entry.py` 保留官方推理脚本及其全部参数，但将 Era3D 自定义 attention 的 xFormers 调用路由到 PyTorch 2.7 fused SDPA shim。shim 兼容本项目使用的 `xformers.ops.memory_efficient_attention` 签名，将 `[batch*heads, sequence, head_dim]` 转为 SDPA 的 4D 形式，并保留 tensor attention bias、dropout、scale 和 output dtype 语义。

补丁只将 `CustomAttention` / `CustomJointAttention` 切换到上游已有的 `XFormersMVAttnProcessor` / `XFormersJointAttnProcessor`；Diffusers 普通 attention 保持 `AttnProcessor2_0`。完整权重加载实测切换 32 个自定义 processor，最终计数为 `XFormersJointAttnProcessor=16`、`XFormersMVAttnProcessor=16`、`AttnProcessor2_0=16`。这避免原 `JointAttnProcessor` 显式物化 attention score matrix 在第一步将 RTX 5070 推到约 11802 MiB 后 OOM，不降低 512 分辨率，也不改变权重、相机、40 步调度或输出定义。

标准模型在 fused SDPA 下已完成 40 步 UNet 去噪，但最终 VAE 一次解码整个多视图 batch 时仅剩约 22 MiB 显存并 OOM。本地 wrapper 现在构造 pipeline 后启用 `enable_vae_slicing()` 和 `vae.enable_tiling()`，不修改上游 tracked 源码。slicing 将 batch 逐张解码，是当前 512×512 输出的主要降峰值措施；tiling 作为更大尺寸的保护，Diffusers 仅在 latent 超过其 tile threshold 时实际分块。此修复不改变去噪步数、权重、相机或输出分辨率。

`scripts/test_fused_attention.ps1` 对 shim 执行 CPU 显式 softmax/bmm 数值对照，并在 RTX 5070 上强制 SDPA Flash Attention backend 做小张量短测试。当前最大绝对误差为 `3.1478703e-07`，默认 scale 误差为 `0`，CUDA 输出全部为有限值；证据见 `logs/fused-attention-test.txt`。

所有环境、Python 运行时、Hugging Face/Torch/CUDA/uv 缓存、权重、临时文件、日志和结果均通过 `scripts/common_wsl.sh` 显式重定向到本目录。脚本不使用 sudo。
`setup.ps1` 会先调用 `fetch_upstream_wsl.sh` 核对官方 commit；如果 `upstream/` 存在未提交的跟踪文件改动，脚本会停止而不会覆盖。

## 目录

```text
era3d/
├── .venv/          # WSL Linux 虚拟环境
├── cache/         # uv/Python/HF/Torch/CUDA/临时缓存
├── checkpoints/   # 固定 revision 的 Hugging Face 权重
├── inputs/        # 前景隔离的 RGBA PNG/WebP
├── logs/          # 环境快照与推理日志
├── outputs/       # 每次运行的 RGB + normal 多视图
├── scripts/       # Windows 入口和 WSL 实现
├── tools/         # 固定的 Linux uv 二进制
└── upstream/      # Era3D 官方仓库
```

## 复现命令

在 PowerShell 中运行：

```powershell
cd D:\Learn\20_Projects\3dresearch\3d-learning\reproductions\多视图复现\era3d
.\scripts\setup.ps1
.\scripts\smoke.ps1
.\scripts\test_fused_attention.ps1
.\scripts\download_weights.ps1 -Variant standard
.\scripts\model_load_smoke.ps1
```

将一张或多张已去背景、带非空 alpha 通道的 `.png` / `.webp` 放入 `inputs/`，然后：

```powershell
.\scripts\run.ps1 -Variant standard -Seed 600 -CropSize 420 -DataloaderWorkers 0
```

`inputs/demo_cleanrot_armor_rgba.png` 是从已固定的官方 `upstream/examples/` 复制的非医学管线 smoke 输入，只用于确认端到端脚本可运行，不计入医学质量评估。

对前视对齐要求高、透视畸变很小的教学渲染，可改用正交权重：

```powershell
.\scripts\download_weights.ps1 -Variant ortho
.\scripts\run.ps1 -Variant ortho -Seed 600 -CropSize 420
```

Era3D 官方建议的可调参数是 `CropSize=400/420` 和 `Seed=42/600`。每次运行会建立独立时间戳目录，避免覆盖旧结果。

`DataloaderWorkers` 默认为 `0`，让单机推理在主进程读取输入。原始配置的 `dataloader_num_workers=1` 会在当前超长 `/mnt/d/.../多视图复现/era3d` 路径下创建 Python `resource_sharer` AF_UNIX socket，已实测触发 `OSError: AF_UNIX path too long`。只有将项目移到更短的 WSL Linux 路径并重新验证后，才建议将 worker 调高。

可在不加载模型、不创建输出目录和不占用 GPU 的情况下验证最终命令：

```powershell
.\scripts\run.ps1 -DryRun
```

输出必须包含 `dataloader_num_workers=0`。

## 数据要求与评估

- 输入必须是 4 通道 RGBA，且 alpha 中必须有非零前景；官方数据加载器会直接按 alpha 计算边界框。
- 用相同器官/细胞资产的留出真值视角比较 RGB，并用渲染的真值法线比较 `normals_*`。
- 对标准化教学器官优先记录轮廓、主解剖标志点和左右/前后方向是否稳定。
- 对细胞核/细胞器优先记录数量、包含关系、相对位置和跨视角同一性；多视图看起来合理不等于生物结构真实。

## 当前状态

- 已完成：上游固定、本地隔离目录、锁定依赖安装、标准权重下载、PowerShell/WSL 可重复入口、Era3D import smoke、完整 FP16 pipeline 权重加载和 RTX 5070 `sm_120` CUDA 短测试。证据见 `logs/environment-freeze.txt`、`logs/smoke.log` 和 `logs/model-load-smoke.log`。
- 已修复：超长 WSL 路径下 `dataloader_num_workers=1` 触发的 `AF_UNIX path too long`；单机入口现默认显式传入 `0`。失败证据、修复说明与 dry-run 验证见 `logs/20260825T162059Z-standard-seed600.log` 和 `logs/dataloader-workers-fix.txt`。
- 已修复：原 `JointAttnProcessor` 显式物化 attention scores 导致的首步 OOM；自定义 attention 现通过 fused SDPA shim 运行。CPU 数值对照、RTX 5070 Flash kernel 短测试和完整 CPU 模型加载均已通过，证据见 `logs/fused-attention-test.txt` 和 `logs/model-load-smoke.log`。
- 已修复：40 步去噪完成后 VAE batch decode 在约 11802 MiB 已占用显存上 OOM；wrapper 现在默认启用 VAE slicing 和 tiling。配置与模型加载证据见 `logs/vae-memory-fix.txt` 和 `logs/model-load-smoke.log`。
- 已完成：标准权重、seed 600、crop size 420、40 步的正式推理成功输出 6 张 RGB 与 6 张 normal，均为 `512×512`。复测用时 `41.54 s`，PyTorch 峰值 `allocated=5459 MiB`、`reserved=5814 MiB`，日志见 `logs/20260825T164609Z-standard-seed600.log`，结果见 `outputs/20260825T164609Z-standard-seed600/`。
- 可重复性：同一配置连续两次运行的 12 个 PNG SHA-256 全部一致；第二次仅增加峰值显存日志，不改变生成结果。
- 当前边界：完成的是多视图 RGB + normal 生成，不是 3D 网格；医学输入和 Instant-NSR 重建属于后续阶段。
