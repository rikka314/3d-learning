# 基于 2D 的 3D 生成与医学教育资产：四篇核心论文精读

> 范围：根据《论文精选与复现路线》收敛出的四篇近期核心模型：SPAR3D、Hunyuan3D 2.1、TIGON、TRELLIS.2。目录 `精选/` 其余论文（综述、场景、4D、部件化等）不在本轮批量深读范围。

## 结论

- [C30.1] 四篇不是同一赛道的“谁更强”：SPAR3D 是低门槛可编辑 mesh 基线，Hunyuan3D 2.1 是 PBR production 候选，TIGON 检验 image+text 的条件增益，TRELLIS.2 给出复杂拓扑/PBR 上界。
- [C30.2] 对医学教育，所有模型只能生成候选草模或 presentation；可发布几何必须来自 verified canonical anatomy/scan-derived segmentation，并经 landmark、part graph、topology 与专家审核。

## 比较矩阵

| 模型 | 真正的技术变量 | 最适合回答的问题 | 当前路线定位 | 关键风险 |
|---|---|---|---|---|
| SPAR3D | point diffusion + triplane meshing | 单图背面如何可编辑、如何直接得到 GLB？ | 首个复现 | 点云表达的是背面 prior，不是事实 |
| Hunyuan3D 2.1 | shape / PBR paint 分离 | geometry 与 material 能否分开验收？ | 主生产候选 | 社区许可与显存；指标不等于解剖正确 |
| TIGON | dual DiT + bridge | text 是否真的补足低信息 image？ | 研究主候选 | image-text 冲突常偏向 image；Gaussian 输出边界 |
| TRELLIS.2 | O-Voxel + SC-VAE | 能否表达复杂拓扑、内腔与 PBR？ | 24GB+ Linux 高端上界 | voxel alias、洞、缺少 semantic graph |

## 复现顺序

1. **SPAR3D**：先建统一 artifact / GLB / Three.js / QC harness。
2. **Hunyuan3D 2.1**：分别跑 shape-only、paint-only、end-to-end；完成许可证审计。
3. **TIGON**：做 image-only、text-only、image+text 与冲突条件实验；只评估条件融合假设。
4. **TRELLIS.2**：在 Linux + NVIDIA ≥24GB 且前述基线已可比较时接入，测复杂表面上界。

## 统一发布门

`candidate generation -> canonical alignment + landmark / part-graph / topology QC -> human revision -> medical reviewer -> GLB + provenance + education-only metadata`

任何一项不通过都不能以“视觉好看”绕过。尤其不允许结构数目、左右侧、连接/包含关系、关键孔道/腔室或主要地标出错。

## 逐篇入口

## SPAR3D

用低分辨率 point diffusion 承担单图不可见面的不确定性，再用 image-conditioned triplane mesher 恢复高保真 PBR mesh；point cloud 也成为可人工编辑的中间控制面。

详见 [SPAR3D 的独立精读报告](../spar3d/report.md)。
## Hunyuan3D 2.1

把单图 image-to-3D 拆成 ShapeVAE + flow-matching DiT 的 geometry stage 与 mesh-conditioned multi-view PBR painter；关键价值是把几何与外观验收分离。

详见 [Hunyuan3D 2.1 的独立精读报告](../hunyuan3d_2_1/report.md)。
## TIGON

保留 image 与 text 两个 DiT 分支，在每层以 zero-initialized bridge 早融合，并在 rectified-flow 每一步平均 velocity；由此支持 image-only、text-only、image+text。

详见 [TIGON 的独立精读报告](../tigon/report.md)。
## TRELLIS.2 / O-Voxel

以 field-free O-Voxel 同时表示 geometry 与 PBR material，经 Sparse Compression VAE 压缩并由 4B flow models 生成；目标是原生处理复杂拓扑、内封闭表面与可 relight 的资产。

详见 [TRELLIS.2 / O-Voxel 的独立精读报告](../trellis_2/report.md)。

## Sources Used

- 原项目路线报告（作为范围和复现优先级证据）
- 四篇论文的官方 arXiv source 与 PDF；SPAR3D/TIGON/TRELLIS.2 使用 CVPR proceedings PDF。
