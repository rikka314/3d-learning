# Coding Agent 生成 3D 的两条路径：Diffusion 控制器与“总监—总管—模块员工”

> 生成日期：2026-09-02  
> 研究对象：[原始猜想](../../thoughts/关于coding%20agent直接输出mesh的猜想.md)  
> 关联整理：[关于 Coding Agent 直接输出 Mesh 的猜想：整理、扩展与研究版图](../../thoughts/关于coding%20agent直接输出mesh的猜想_整理与研究版图.md)  
> 资料范围：论文、官方项目页、官方代码与 API 文档；产品能力以检索日为准  
> 证据置信度：路径一“可实现性”高；路径二“组件可实现性”高、“完整体系成熟度”低至中

## 一、结论先行

原稿提出的两条路径都成立，但它们不是互斥方案，而是两个不同维度：

- **路径一是生成能力与表示路线**：coding agent 不逐点续写 mesh，而把 2D/multi-view/3D diffusion 或 flow model 当作工具；它规划输入、生成候选、看多视图、调参数、局部重生成，再用 Blender/CAD 工具把结果清理成目标资产。
- **路径二是系统组织路线**：总监负责全局评审，总管负责编译对象结构和接口契约，模块员工负责局部生成或编辑；它可以调用 diffusion，也可以调用 CAD、CSG、Geometry Nodes、SDF、资产检索或直接写 Blender Python。

截至 2026-09-02，路径一已经从 2022 年的“每个对象优化约 1.5 小时”扩展到秒级或分钟级的单图到 3D、原生 3D structured latent、多部件生成和 3D reward guidance。这里的速度不能直接横比：秒级数字主要来自受单张条件图约束的 feed-forward reconstruction，不能与从文本零样本创作的 SDS 任务视作同一种问题。DreamFusion、Magic3D、MVDream、Stable Fast 3D、Hunyuan3D、TRELLIS、PartCrafter 等已经提供部分生成底座；GenArtist、LL3M、SceneWeaver、SAGE 则展示了、或在各自研究设定中验证了“agent 选工具—生成—看结果—反思—修复”的控制闭环。[DreamFusion](https://arxiv.org/abs/2209.14988)、[Stable Fast 3D](https://arxiv.org/abs/2408.00653)、[TRELLIS](https://arxiv.org/abs/2412.01506)、[SAGE](https://arxiv.org/abs/2602.10116)

路径二也不是空白。3D-GPT、LL3M、SceneWeaver、SAGE 已分别验证角色分工、Blender code、视觉/物理 critic 和 tool routing；PartGen、PartCrafter、AutoPartGen、FullPart、CompoSE 已验证部件分解、layout-first 和跨部件一致性。不过，本次检索未在同行评审研究中发现一个已经成熟地完成以下全链条的通用 object-level 系统：

```text
多视图总监定位错误
→ 总管把错误归因到具体部件或接口
→ 每个部件由独立 worker 按 typed contract 生成
→ 只重建失败部件
→ 自动证明其他部件未回归
```

最接近原稿设想的是 2026 年公开的 [OpenTopos](https://github.com/gaoypeng/opentopos)：其 README 自述以 `design.json` 保存每个部件的 world-space bounding-box contract，让多个 coding agent 并行编写 Blender Python，随后装配、渲染、多视图 VLM 打分并选择性返工。可是项目作者明确把它标记为 **work-in-progress research preview**；本次检索未找到其同行评审论文或独立 benchmark，因此不能把“已有原型”写成“问题已解决”。

本次研究最重要的判断是：

> **可研究的核心不再是“让更多 AI 一起生成 mesh”，而是构建一个 Agentic 3D Compiler：总管把需求编译成 part graph、坐标、接口和验收测试；不同 worker 选择最合适的表示生成局部；确定性 assembler 装配；总监把多视图、几何、拓扑和物理证据转换成可执行的局部 defect ticket。**

## 二、概念澄清：两条路径到底分别研究什么

### 2.1 路径一：“调用 diffusion”和“调教 diffusion”不是一回事

“调教”至少包含四个技术层级：

| 层级 | agent 实际修改什么 | 是否改模型权重 | 当前成熟度 |
|---|---|---:|---|
| L1 工具调用 | 选择模型、prompt、reference image、输出格式 | 否 | 高 |
| L2 推理时闭环 | seed、CFG、camera、denoise、ControlNet、候选筛选、局部重生成 | 否 | 中高 |
| L3 每资产优化 | 冻结 diffusion，用 SDS/VSD/reward gradient 优化 NeRF、DMTet、mesh 或 latent | 通常否 | 中高，但成本较高 |
| L4 后训练/对齐 | LoRA、DreamBooth、multi-view fine-tuning、DPO/RL/reward fine-tuning | 是 | 2D 较成熟，3D 仍早期 |

DreamFusion 的 SDS 属于 L3：diffusion 权重不变，变化的是被优化的 3D 表示。[DreamFusion](https://dreamfusion3d.github.io/) DreamBooth3D 同时涉及个性化 2D diffusion 和 3D 优化，更接近 L4。[DreamBooth3D](https://arxiv.org/abs/2303.13508) DreamReward 与 DreamCS 开始把人类偏好或 3D 几何 reward 用于 3D 生成对齐，但这仍是研究型训练流程，并不是通用 coding agent 随手调用即可可靠完成的能力。[DreamReward](https://arxiv.org/abs/2403.14613)、[DreamCS](https://arxiv.org/abs/2506.09814)

### 2.2 路径二：“多 agent”不是关键变量

原稿中的角色可以形式化为：

| 原稿角色 | 更精确的系统角色 | 输入 | 输出 |
|---|---|---|---|
| 总监 | Global Critic / QA Router | 多视图 render、normal/depth/object-ID、几何和物理测试 | `DefectTicket`、通过/失败、证据和重验范围 |
| 总管 | AssetSpec Compiler / Planner / Router | 用户意图、参考图、领域 ontology、历史 artifact | part graph、坐标系、接口、依赖 DAG、表示选择、验收测试 |
| 模块员工 | Part Builder / Editor | 自己的 `PartSpec`、邻接 proxy、工具 | 可执行源码或局部几何、预览、测量值和测试证据 |
| 原稿未显式提出 | Deterministic Assembler / Compiler | 所有通过局部 gate 的 `PartArtifact` | GLB、USD、FBX、URDF、mesh、3DGS 或其他交付物 |

需要增加第四层，是因为装配、单位换算、坐标变换、文件导出和几何 gate 不应该全部依赖 LLM 自由发挥。MetaGPT 对多智能体软件工程的结论也支持把职责和中间产物写成 SOP，减少自由聊天引发的级联幻觉。[MetaGPT](https://arxiv.org/abs/2308.00352)

## 三、路径一：Coding Agent 调用、控制与对齐 Diffusion

### 3.1 研究背景：从 2D 先验“蒸馏”出 3D

#### 阶段 A：冻结 2D diffusion，逐对象优化 3D 表示（2022—2023）

DreamFusion 的关键突破不是让模型直接输出 mesh，而是把预训练 text-to-image diffusion 变成一个可微的先验：随机选相机渲染当前 NeRF，把图像交给 diffusion 计算 SDS 梯度，再用梯度更新 3D 表示。它无需成对 text–3D 数据，产物先是 NeRF，随后才能通过 marching cubes 等方法提取 mesh。[DreamFusion 论文](https://arxiv.org/abs/2209.14988)

这直接支持原稿的一个直觉：agent 不必“记住所有顶点”，它可以操作 prompt、相机、渲染器和优化器。但它也暴露了根本问题：2D diffusion 只要求每个单独视角“像”，不自动保证所有视角属于同一个对象。DreamFusion 展示了视角 prompt、textureless geometry evaluation 和相关失败例；后续 MVDream 与 T³Bench 则更直接处理或评测 Janus/跨视角不一致。[DreamFusion 项目页](https://dreamfusion3d.github.io/)、[MVDream](https://arxiv.org/abs/2308.16512)、[T³Bench](https://arxiv.org/abs/2310.02977)

Magic3D 把流程改成 coarse-to-fine：先用低分辨率 prior 得到粗 3D，再将其初始化为 textured mesh，并以高分辨率 latent diffusion 和可微渲染器继续优化。论文报告约 40 分钟完成，相比 DreamFusion 约快 2 倍，盲测中 61.7% 的参与者偏好 Magic3D；这些数字只代表论文设置，不是任意硬件和 prompt 的 SLA。[Magic3D](https://research.nvidia.com/labs/cosmos-lab/magic3d/)

ProlificDreamer 用 Variational Score Distillation 处理 SDS 的过饱和、过平滑和低多样性；Fantasia3D 则用 DMTet、normal supervision 和 BRDF 把 geometry 与 appearance 分开。这两类工作说明：agent 的控制对象不只是一段 prompt，还包括表示、优化目标、noise schedule、camera distribution、geometry stage 和 material stage。[ProlificDreamer](https://arxiv.org/abs/2305.16213)、[Fantasia3D](https://openaccess.thecvf.com/content/ICCV2023/html/Chen_Fantasia3D_Disentangling_Geometry_and_Appearance_for_High-quality_Text-to-3D_Content_Creation_ICCV_2023_paper.html)

#### 阶段 B：多视图 diffusion 约束跨视角一致性（2023—2024）

MVDream 不再只对独立视角应用普通 2D prior，而是联合生成 camera-conditioned 多视图图像，并可作为通用 3D prior 接入 SDS。它支持“同一对象在不同角度保持一致”的方向，但仍不能证明隐藏结构、精确尺度或生产 topology 正确。[MVDream](https://arxiv.org/abs/2308.16512)

因此，agent 调参时要区分两类杠杆：

- `prompt / negative prompt / seed / CFG` 主要改变采样分布；
- `camera-conditioned multi-view prior / depth-normal condition / differentiable renderer / 3D reward` 才直接向几何一致性施加约束。

后一类通常比“多抽几次、让 VLM 选最好看的一张”更重要，这是从 DreamFusion、MVDream 和 DreamCS 的组合证据得出的系统设计推断。[MVDream](https://github.com/bytedance/MVDream)、[DreamCS](https://arxiv.org/abs/2506.09814)

#### 阶段 C：Feed-forward reconstruction、原生 3D latent 与 flow/diffusion 模型（2024—2026）

| 系统 | 年份 | 模型范式 | 主要表示与产物 | 对 coding agent 的意义 | 证据边界 |
|---|---:|---|---|---|---|
| Stable Fast 3D | 2024 | feed-forward single-image reconstruction | 单图到 UV-unwrapped textured mesh，含 material parameters | 可作为快速候选生成器和 API 工具 | 论文/官方资料报告约 0.5 秒，不等于 production-ready topology |
| TripoSR | 2024 | feed-forward single-image reconstruction | 单图到 mesh | 低延迟粗模，适合大量候选 | 隐藏面仍由 prior 补全 |
| TRELLIS | 2024/2025 | structured latent + rectified flow | 可解码 radiance field、3D Gaussian、mesh | agent 可先固定内容，再按交付目标选择表示 | 需要后续资产级验收 |
| Hunyuan3D 2.0 | 2025 | flow-based DiT + texture diffusion | shape generator + 独立 texture model | 允许先改形状、后重贴图 | 论文比较与官方 demo 不能替代独立生产测试 |
| TripoSG | 2025 | large-scale rectified flow | 3D shape synthesis | 提供强 image-to-shape backbone | 更侧重生成质量，不保证 rig/UV/碰撞 |
| PartCrafter | 2025 | compositional 3D mesh DiT | hierarchical attention，输出多个独立 mesh part | **系统推断：**统一生成模型可以承担部分跨部件一致性，而不必把一致性全部交给 agent 通信 | 它不是多 agent 系统 |
| O-Voxel / TRELLIS.2 | 2025/2026 | O-Voxel VAE + large-scale flow matching | 表示可表达 open、non-manifold、enclosed surfaces 和 PBR 属性 | 对内部结构和复杂 topology 更有潜力 | 表示能力不等于每个结果都有干净、production-ready topology |
| CompoSE | 2026 | part-aware DiT | coarse boxes 控制的 part-separated synthesis/editing | 支持 add/delete/substitute/resize 等局部编辑 | 仍由统一 DiT 维护全局，不是 per-part agent |

上述事实来自各项目论文或官方资料：[Stable Fast 3D](https://arxiv.org/abs/2408.00653)、[TripoSR](https://arxiv.org/abs/2403.02151)、[TRELLIS](https://arxiv.org/abs/2412.01506)、[Hunyuan3D 2.0](https://arxiv.org/abs/2501.12202)、[TripoSG](https://arxiv.org/abs/2502.06608)、[PartCrafter](https://arxiv.org/abs/2506.05573)、[O-Voxel](https://arxiv.org/abs/2512.14692)、[CompoSE](https://arxiv.org/abs/2605.19350)。

其中 TRELLIS 特别符合原稿“不一定先输出 mesh”的想法：同一 structured latent 可解码成多种表示，并支持 region-specific editing。[TRELLIS 官方代码](https://github.com/microsoft/TRELLIS) 但这并不意味着表示差异消失；3DGS 擅长新视角渲染，mesh 擅长编辑、碰撞、动画和 DCC 互操作，两者仍有不同的下游约束。

### 3.2 Coding agent 当前能怎样“调用”生成器

路径一已经有三类可运行接口：

1. **本地开源模型**：agent 写配置和脚本，调用 Stable Fast 3D、Hunyuan3D、TRELLIS 等模型，保存权重版本、seed、输入图和产物。
2. **异步生成 API**：Meshy 与 Tripo 都提供 image-to-3D 任务接口，返回 task id、状态和资产 URL；两者另有 text-to-3D 能力，需按各自总览或对应 endpoint 调用。这类接口适合 agent 实现 `submit → poll → render → judge → retry` 的状态机。[Meshy 总览](https://docs.meshy.ai/en)、[Meshy Image-to-3D](https://docs.meshy.ai/en/api/image-to-3d)、[Tripo Image-to-Model](https://developers.tripo3d.com/en/docs/generation-image-to-model/standard)、[Tripo 总览](https://docs.tripo3d.ai/)
3. **DCC 工具接口**：Blender 的实验性 MCP server 或 Python API 允许 agent 导入模型、测量、重拓扑、设材质、渲染和导出。Blender 官方同时警告该 MCP 可执行 LLM 生成的代码，因此必须采用 sandbox、allowlist、版本化 artifact 和可恢复的工作区。[Blender MCP Server](https://www.blender.org/lab/mcp-server/)

GenArtist 已在 2D 场景中展示 MLLM 可把多个生成/编辑模型组织成 tool library，并通过 planning tree 执行分解、验证和 self-correction；论文报告其在 T2I-CompBench 的 attribute-binding 维度相对 DALL-E 3 提升接近或超过 7%，但这是特定图像指标，不能读成总体质量提升，更不能直接外推为 3D 质量。[GenArtist](https://arxiv.org/abs/2407.05600)

更直接的 3D 证据来自 SAGE：agent 通过工具编排 layout 与 object generators，其中对象生成可调用 TRELLIS；在该论文的 physical-review 消融设置中，视觉 critic 提升视觉质量，physics critic 把碰撞率从 7.8% 降至 1.9%、稳定性提高到 99.6%。这表明“agent 调 3D generator + 多种 critic 闭环”已经能在 scene level 运行，但 SAGE 的目标是 simulation-ready 室内场景，而不是精细 object-level topology。[SAGE](https://arxiv.org/abs/2602.10116)

### 3.3 一个可审计的 diffusion 控制闭环

```text
用户需求 / 参考图 / 目标用途
  ↓
Spec Planner：对象语义、部件、尺寸、风格、交付格式、预算
  ↓
Representation Router：2D→multi-view→3D，或直接原生 3D generator
  ↓
Generator：生成 K 个候选，保存 model/version/seed/config
  ↓
Renderer：固定 camera rig 输出 RGB + silhouette + normal + depth + object-ID
  ↓
Critics：VLM 语义审查 + 数值 geometry tests + topology/physics tests
  ↓
Controller：改 prompt/seed/control，局部重生成，或转 Blender/CAD 修复
  ↓
Regression：未涉部件和既有约束不得退化
  ↓
Export：GLB / USD / FBX / mesh / 3DGS / renders
```

建议把 agent 可调变量限制为显式、可记录的 config：

```yaml
generator:
  model_id: microsoft/TRELLIS-image-large
  model_revision: <pinned-revision>
  seed: 1042
  guidance_scale: 7.5
  reference_image: artifact://refs/heart_front.png
camera_rig:
  azimuths: [0, 45, 90, 135, 180, 225, 270, 315]
  elevations: [0, 25, -20]
checks:
  require_same_semantic_identity_across_views: true
  require_part_count: 4
  require_watertight: true
  max_triangles: 80000
```

这使“调教”从不可追溯的聊天变成可复现实验。

### 3.4 真正修改 diffusion 权重：现在做到哪一步

2D diffusion 的 preference alignment 已有 DDPO、Diffusion-DPO 和 D3PO：它们分别把 denoising 视作多步决策过程，或从成对偏好直接优化 diffusion。DDPO 还展示了用 vision-language model feedback 改善 prompt-image alignment；Diffusion-DPO 使用 851K Pick-a-Pic 偏好对微调 SDXL；D3PO 避免单独训练 reward model。[DDPO](https://arxiv.org/abs/2305.13301)、[Diffusion-DPO](https://arxiv.org/abs/2311.12908)、[D3PO](https://openaccess.thecvf.com/content/CVPR2024/html/Yang_Using_Human_Feedback_to_Fine-tune_Diffusion_Models_without_Any_Reward_CVPR_2024_paper.html)

3D 方向更晚。DreamReward 收集 25K expert comparisons 并训练 Reward3D；DreamCS 用 unpaired 3D preference data 训练 geometry-aware reward，并把它接入 DreamFusion、MVDream、Magic3D、Fantasia3D 和 TRELLIS 等 backbone。论文报告 RewardCS 可降低 Janus artifact，并指出纯 2D reward 容易偏向图像美学而不是 3D 几何。[DreamReward](https://arxiv.org/abs/2403.14613)、[DreamCS](https://arxiv.org/abs/2506.09814)

因此，截至当前更准确的成熟度判断是：

- **agent 自动调用预训练 3D generator：高可行；**
- **agent 基于多视图与几何测试搜索 prompt/seed/control：可行，但需自建 harness；**
- **agent 逐对象做 SDS/VSD/reward-guided optimization：可行，成本与稳定性仍是问题；**
- **agent 自动决定何时、用什么数据去微调 3D diffusion，并保证未破坏通用能力：仍是早期研究。**

### 3.5 路径一的现有瓶颈

1. **单图不可识别信息无法凭空恢复。** 隐藏面、内部腔体和真实厚度只能由 prior 猜测；对“创造一个合理对象”可以接受，对“还原特定对象”则需要更多视角、扫描或 verified geometry。
2. **好看的 render 不等于好 mesh。** topology、non-manifold、self-intersection、UV seam、material bake、LOD、rig、collision proxy 仍需专门验证。
3. **2D critic 会奖励纹理作弊。** DreamCS 的结果表明 geometry-aware 3D reward 比纯 2D preference 更能约束 Janus 和几何完整性。[DreamCS](https://arxiv.org/abs/2506.09814)
4. **局部重生成会破坏接口。** 若没有部件 bbox、anchor、joint 和 boundary contract，diffusion 修改一个部位时可能改变相邻区域或全局风格。
5. **训练时“调教”成本高。** 数据许可、显存、checkpoint 管理、catastrophic forgetting 和评测集污染都比 prompt search 更难自动化。

## 四、路径二：总监—总管—模块员工

### 4.1 背景：分层多智能体、critic loop 与结构化 3D 的汇合

通用多智能体研究已经验证角色分工与分层聚合，但也显示“增加 agent 数”本身并不可靠。MetaGPT 把 SOP 编码进多角色流水线；Mixture-of-Agents 让后一层消费前一层多个输出；Reflexion 把失败转换成下一轮可复用的文字记忆。[MetaGPT](https://arxiv.org/abs/2308.00352)、[Mixture-of-Agents](https://arxiv.org/abs/2406.04692)、[Reflexion](https://arxiv.org/abs/2303.11366)

反面证据同样重要。2025 年对 5 个多智能体框架、150 多个任务的研究把失败归纳为 specification/system design、inter-agent misalignment、verification/termination 三大类，并发现仅仅写清角色或换 orchestration 仍不能消除大量失败。[Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) 2026 年的 agent scaling 研究进一步指出，同质 agent 很快出现边际收益递减，真正有帮助的是不同模型、提示、工具或证据来源提供的互补通道。[Understanding Agent Scaling via Diversity](https://arxiv.org/abs/2602.03794)

这意味着“一个部位一个相同 LLM”可能只是扩大成本和相关性错误。模块员工应按能力异构：CAD worker、procedural worker、organic generator worker、texture worker、rig worker 和 deterministic verifier 才是更有意义的分工。

### 4.2 3D-specific 公开成果：与原稿的匹配程度

| 系统 | 年份/状态 | 已实现什么 | 与原稿完整设想的差距 |
|---|---|---|---|
| 3D-GPT | 2023，论文 | task dispatch、conceptualization、modeling 三 agent；调用 Blender procedural generation | 更像场景级角色流水线，没有 per-part contract 与多视图 blame assignment |
| BlenderAlchemy | 2024，论文 | VLM 作为 visual editor/state evaluator 搜索 Blender 编辑序列 | 不是分层多 agent，也不负责部件并行装配 |
| PartGen | CVPR 2025 | 多视图 part segmentation、遮挡补全、逐部件重建 | 生成网络，不是 agent 组织 |
| PartCrafter | 2025，论文；官方仓库发布状态需按 commit 核验 | 多 part 联合去噪、cross-part hierarchical attention | 没有 agent、typed contract 和 critic repair loop |
| AutoPartGen | NeurIPS 2025 | 逐部件自回归生成，后续部件 condition on 已生成部件，自动决定部件数量 | 串行生成模型，不是独立员工并行 |
| LL3M | 2025，论文/代码 | 多角色规划、检索、写 Blender Python、debug、视觉/代码自评与用户编辑 | 未公开证明 one-worker-per-part 与显式 assembly contract |
| SceneWeaver | 2025，论文 | 标准化工具接口、reason-act-reflect、视觉/物理/语义反馈和最多 10 轮修正 | 面向室内场景，不是 object-level mesh ownership |
| FullPart | ICLR 2026 | 先 bbox layout，再让每个 part 在独立 full-resolution voxel grid 生成，并做跨尺度对齐 | 单一模型，没有 agent/critic orchestration |
| SAGE | 2026，论文/代码/数据 | layout/object generator + visual/physical critic + MCP tool orchestration | 面向 embodied scene；对象多为 generator 产物，不做细粒度 topology responsibility |
| CompoSE | 2026，预印本 | coarse part boxes 控制联合 synthesis 和局部 edit | 统一 diffusion model，不是部件 agent |
| P3D-Bench | 2026，benchmark | 400 text、400 image、203 assembly cases；评 executability、geometry、topology、约束、多视图和 part structure | 它是评测，不是生成系统；结果反而显示 assembly/part-level 仍弱 |
| OpenTopos | 2026，开源 research preview | design contract、N 个 part coding agents、build、joints、8-view render、VLM judge、selective fix-loop | 与原稿最接近，但未同行评审、作者明确称 WIP、缺少独立 benchmark |

来源：[3D-GPT](https://arxiv.org/abs/2310.12945)、[BlenderAlchemy](https://arxiv.org/abs/2404.17672)、[PartGen](https://arxiv.org/abs/2412.18608)、[PartCrafter](https://arxiv.org/abs/2506.05573)、[AutoPartGen](https://proceedings.neurips.cc/paper_files/paper/2025/hash/e19b6f65791e350347bcff8a3955cb5b-Abstract-Conference.html)、[LL3M](https://arxiv.org/abs/2508.08228)、[SceneWeaver](https://arxiv.org/abs/2509.20414)、[FullPart](https://proceedings.iclr.cc/paper_files/paper/2026/hash/4c2092ec0b1370cce3fb5965ab255fae-Abstract-Conference.html)、[SAGE](https://arxiv.org/abs/2602.10116)、[CompoSE](https://arxiv.org/abs/2605.19350)、[P3D-Bench](https://arxiv.org/abs/2606.11152)、[OpenTopos](https://github.com/gaoypeng/opentopos)。

P3D-Bench 是判断成熟度的关键反证：frontier MLLM 已经常能恢复对象的全局形状和语义，但 assembly 是最难任务，模型仍会弄错精确参数、部件数和每个部件的几何。[P3D-Bench](https://arxiv.org/abs/2606.11152) 因而“多 agent 自动装配复杂对象”还不能仅凭 demo 判定成熟。

### 4.3 OpenTopos：与原稿近乎同构，但只是一份研究预览

OpenTopos 的公开架构是：

```text
prompt / reference image
  → design agent：design.json，列出部件与 world bbox contract
  → N 个 part agents 并行：每个写一个 build_<part>() Python 文件
  → build agent：导入并组装所有部件，验证 bbox
  → joints agent：生成 joints.yaml
  → headless Blender：8-view render + GLB + URDF
  → VLM judge：低于阈值则 fix-loop，只返工失败部件
```

其 `design.json` contract 让相互看不到代码的 part agents 仍能对齐，build 阶段以 5 mm tolerance 检查 world-space bbox；交付真值是可重跑的 Python project，GLB/URDF/render 是派生产物。[OpenTopos README（固定提交）](https://github.com/gaoypeng/opentopos/blob/8c970a8f1ca2847d200cddcdfff2edb41130fbee/README.md#L17-L87)、[bbox contract ADR（固定提交）](https://github.com/gaoypeng/opentopos/blob/8c970a8f1ca2847d200cddcdfff2edb41130fbee/docs/decisions/0006-design-json-bbox-contract.md#L8-L31)、[当前 architecture](https://github.com/gaoypeng/opentopos/blob/master/docs/architecture.md)

这几乎正面验证了原稿“总管拆分、员工分部件、总监看多视图、局部返工”的工程可行性。但证据边界必须保留：

- 项目方明确写明 `work-in-progress research preview`；
- 没有经过同行评审；
- 本次检索未发现其与 LL3M、PartCrafter 或人工建模的统一、独立评测；
- bbox contract 只能约束位置与尺度，不能单独保证接触面、拓扑、关节、材质连续性和解剖正确性。

OpenTopos 已公开展示的是一个高度同构的工作流；本报告后文提出的 typed `DefectTicket`、显式 owner 路由和形式化 3D blame assignment，不是该项目已经公开验证的能力。所以 OpenTopos 更适合被视为“该猜想已出现同构原型”，而不是“该方向已被解决”。

### 4.4 为什么部件生成不能真正相互独立

几条部件生成论文从不同角度给出同一个结论：

- PartGen 在补全某个不可见部件时仍使用整个对象上下文；[PartGen](https://arxiv.org/abs/2412.18608)
- PartCrafter 在 part-local token 外加入 cross-part hierarchical attention；[PartCrafter](https://arxiv.org/abs/2506.05573)
- AutoPartGen 让后一个部件 condition on 已生成部件；[AutoPartGen](https://proceedings.neurips.cc/paper_files/paper/2025/hash/e19b6f65791e350347bcff8a3955cb5b-Abstract-Conference.html)
- FullPart 先生成全局 bbox layout，再用 center-point encoding 交换不同尺度部件的信息；[FullPart](https://proceedings.iclr.cc/paper_files/paper/2026/hash/4c2092ec0b1370cce3fb5965ab255fae-Abstract-Conference.html)
- CompoSE 交替执行 part-local processing 与 global aggregation。[CompoSE](https://arxiv.org/abs/2605.19350)

因此，模块员工应该拥有**局部写权限**，但不能只有局部信息。至少要读取：自己的 `PartSpec`、父子/邻接关系、相邻部件 proxy、全局尺度与风格 token，以及不可违反的接口测试。

### 4.5 总管应输出 typed contract，而不是一段长规则

> **综合设计提议：**以下协议是基于 OpenTopos、PartGen、FullPart 与通用 agent 编排抽象出的强化方案，不是已有单篇论文统一实现。

一个最小 `PartSpec` 可以写成：

```json
{
  "asset_spec_version": "v17",
  "part_id": "front_wheel",
  "owner": "wheel_builder",
  "frame": "world_RH_Zup_m",
  "target_obb": {
    "center": [0.82, 0.0, 0.31],
    "extent": [0.06, 0.70, 0.70],
    "tolerance_m": 0.005
  },
  "interfaces": [
    {
      "id": "axle",
      "type": "revolute",
      "axis": [0, 1, 0],
      "clearance_m": 0.003,
      "connects_to": "fork.axle_socket"
    }
  ],
  "constraints": {
    "watertight": true,
    "max_triangles": 12000,
    "allowed_overlap_with": ["fork"]
  },
  "dependencies": ["fork"],
  "acceptance_tests": [
    "obb_tol_5mm",
    "no_collision_except_allowlist",
    "joint_axis_fit"
  ]
}
```

总管必须维护的全局不变量包括：

- 唯一单位、handedness、up-axis 和 canonical frame；
- part tree 与 sibling relation graph；
- bbox/OBB、anchors、joints、shared boundary、clearance 和允许穿插区域；
- manifold/watertight/normal/triangle/UV/material/LOD 要求；
- 依赖 DAG、owner、artifact version 和 invalidation 规则；
- 对称、包含、邻接、连接、重复数量与关键 landmark。

### 4.6 总监不应只输出“看起来不对”

> **综合设计提议：**以下 `DefectTicket` 是建议协议；现有项目多提供评分、文字建议或 fix loop，尚未形成统一行业标准。

总监的反馈应是可被总管路由的 defect ticket：

```json
{
  "issue_id": "D-104",
  "asset_spec_version": "v17",
  "owners": ["front_wheel", "fork"],
  "evidence": [
    {"camera": "rear_left_45", "render_id": "r308"},
    {"check": "joint_axis_fit", "measured_error_m": 0.012}
  ],
  "violated_contract": "front_wheel.axle ↔ fork.axle_socket",
  "severity": "blocker",
  "suggested_local_test": "axle_distance_and_clearance",
  "recheck_scope": "affected_parts_then_global"
}
```

评审至少分六层：

1. **文件与几何 gate**：可加载、非退化面、法线、non-manifold、watertight、面数和 UV/material budget；
2. **接口 gate**：OBB 误差、anchor pose、joint axis/origin、clearance、接触与非许可 interpenetration；
3. **结构 gate**：部件数量、part graph、左右/对称、包含和关键 landmark；
4. **多视图 gate**：固定前后左右、俯仰和接口 close-up，输出 RGB/normal/depth/object-ID；
5. **功能 gate**：joint sweep、动画、碰撞、GLB/URDF import smoke test；
6. **回归 gate**：ticket 之外的部件保存 geometry/render hash 或容差内特征，防止“修轮子时车架消失”。

T³Bench 已说明 text-to-3D 不能只用单视图 CLIP，并以多视图 quality 与 alignment 评估 view inconsistency；MATE-3D/HyperScore 又把 quality、geometry、texture 和 text alignment 分成不同维度。[T³Bench](https://arxiv.org/abs/2310.02977)、[MATE-3D](https://openaccess.thecvf.com/content/ICCV2025/papers/Zhang_Benchmarking_and_Learning_Multi-Dimensional_Quality_Evaluator_for_Text-to-3D_Generation_ICCV_2025_paper.pdf) VLM 适合做语义和视觉缺陷探测器，但尺寸、碰撞、可动性和 topology 仍应由确定性工具判定。

### 4.7 上下文、并发与成本

原稿认为分部件可以解决 mesh context overflow，这只对了一半。更根本的解法是把 mesh 留在 Blender/CAD kernel/artifact store 中，LLM 只读取对象 handle、局部统计、低模 proxy、渲染和失败报告。否则即使有 N 个 agent，只要每个都收到完整 mesh 与完整聊天历史，成本和上下文问题仍然存在。

建议的调度原则是：

- 只有没有未冻结依赖的 part 才并发；
- 对称件、重复件和低风险小件共享 generator 或 instance；
- 相邻关系只做 graph-neighborhood collision/contact tests，避免所有部件两两对话导致近似 `O(n²)` 通信；
- 全局比例错误先修改 `AssetSpec`，再 invalidate 依赖子图，而不是让十个 worker 分别打补丁；
- 设置最大 revision、token/GPU/API 预算、quality threshold 和不可改善停止条件；
- 只有复杂、失败或需要异构工具的部件才展开为独立 worker。

“异构工具比同质 agent 数量更有价值”的判断，与 2026 年 agent scaling 的实验方向一致。[Understanding Agent Scaling via Diversity](https://arxiv.org/abs/2602.03794)

### 4.8 路径二的成熟度

> 以下成熟度是本报告对多类证据的综合判断，不是来自单一 benchmark 的分数。

| 能力 | 成熟度判断 | 当前证据 |
|---|---|---|
| LLM 调 Blender/CAD/procedural tools | 中高 | 3D-GPT、LL3M、BlenderAlchemy、OpenTopos |
| 多视图 VLM critic 与自动 refinement | 中 | LL3M、SceneWeaver、SAGE、OpenTopos |
| 语义部件生成与局部编辑 | 中高 | PartGen、PartCrafter、AutoPartGen、FullPart、CompoSE |
| 固定 bbox/anchor contract 的并行 part agents | 低至中 | OpenTopos 有直接原型，但缺独立学术验证 |
| 3D error blame assignment 到 part/interface/source node | 低 | 找到的系统多能评分或提出修改，缺统一 benchmark |
| 局部 patch 后证明全局无回归 | 低 | 需要 semantic diff、局部与全局回归测试 |
| 有机体/解剖/干净 production topology | 低 | 当前最强证据仍偏视觉质量、常见资产或规则结构 |

## 五、两条路径的真正关系：最有前景的是组合，而不是二选一

> **组合架构推断：**下图综合多篇论文与工程原型，不是对任何一个现成系统的逐项复述。

两条路径可以组合成：

```text
                    ┌──────────────────────────────┐
用户目标 / 参考图 → │ 总管：AssetSpec + Part Graph │
                    └──────────────┬───────────────┘
                                   ↓
                    Representation / Tool Router
                 ┌────────────┬────────────┬────────────┐
                 ↓            ↓            ↓            ↓
           CAD/CSG worker  Procedural    Diffusion     Asset/Rig
                          Blender worker  worker        worker
                 └────────────┴────────────┴────────────┘
                                   ↓
                     Deterministic Assembler/Compiler
                                   ↓
               RGB + normal + depth + object-ID + geometry tests
                                   ↓
              总监：visual + semantic + topology + physics critics
                                   ↓
                   DefectTicket → 总管 → 局部 worker
```

这里 diffusion 是“模块员工的工具之一”，而不是整套架构的替代品：

- 规则硬表面、精确尺寸：CAD/CSG；
- 重复结构：Geometry Nodes / procedural instances；
- 有机主体：3D diffusion、SDF 或 structured latent；
- 薄片、管道、血管：curve/sweep；
- 纹理和风格细节：multi-view diffusion；
- 关节、碰撞和导出：确定性 rig/physics/export tools；
- 仅作浏览的背景或照片感对象：3DGS/NeRF。

这种组合比“所有员工都直接写 mesh”更符合现有证据：TRELLIS 表明同一 structured latent 可以解码为不同表示，PartCrafter/FullPart 表明局部生成需要全局信息，LL3M/OpenTopos 为代码和 contract 支持局部修改提供了先例，SAGE 的消融显示 visual 与 physics critic 具有互补作用。[TRELLIS](https://arxiv.org/abs/2412.01506)、[FullPart](https://proceedings.iclr.cc/paper_files/paper/2026/hash/4c2092ec0b1370cce3fb5965ab255fae-Abstract-Conference.html)、[LL3M](https://arxiv.org/abs/2508.08228)、[SAGE](https://arxiv.org/abs/2602.10116)

## 六、对原稿各个判断的研究性回应

| 原稿判断 | 研究后的结论 |
|---|---|
| 直接续写复杂 mesh 很脆弱 | 基本正确，但 tokenization、序列化和 topology constraint 不是无意义工程；它们是专门 mesh model 的核心问题。对通用 coding agent，操作高阶程序/工具通常更合适。 |
| 人不算顶点，所以 AI 也不应算顶点 | 方向上成立，但 diffusion 仍在计算，只是把几何先验压入参数/latent。更精确的说法是“不把原始顶点序列放进 agent 的工作记忆”。 |
| coding agent 调 diffusion | 已经可实现；应把 agent 定义为 controller，负责规格、调用、观测、调参、修复和导出，而不是把 diffusion 当作黑盒一次生成。 |
| 总监看多视图、总管拆部件、员工分别做 mesh | 已出现同构开源原型 OpenTopos，也有大量局部学术先例；但完整体系仍缺同行评审 benchmark 和稳定的 3D blame assignment。 |
| 分部件可解决上下文溢出 | 只有在外部 artifact store、局部 slice、引用式 handle 和 typed contract 下才成立；单纯增加 agent 会把上下文问题变成通信问题。 |
| 360°视频可以替代 3D | 只对固定浏览轨迹成立。自由相机、拾取、剖切、编辑、动画、碰撞和仿真仍需要真实 3D 表示。 |
| 从粗到细、局部到完整 | 已是成熟研究主题；真正较少研究的是“部件所有权 + 接口契约 + 错误归因 + 局部回归证明”。 |

## 七、最值得继续研究的问题

### 7.1 3D blame assignment 与 semantic diff

目标不是只问“模型好不好看”，而是回答：哪个 part、哪个 interface、哪个 source node 造成哪个失败；修改后哪些邻域必须重测。P3D-Bench 已开始评测 part structure 和 assembly，但尚未评测 defect localization 与 patch regression。[P3D-Bench](https://arxiv.org/abs/2606.11152)

### 7.2 Agent-driven representation routing

研究总管能否根据形状、精度、编辑、动画、预算和交付格式，为每个部件选择 CAD、procedural、diffusion、SDF、curve、3DGS 或检索资产，并把异构结果编译为统一场景。当前 pipeline 经常手工混合这些工具，自动、可验证的 routing 仍少。

### 7.3 Contract-conditioned local diffusion

现有 PartCrafter、FullPart、CompoSE 已能接收全局/局部结构条件，但可以进一步让 diffusion worker 必须满足明确的 anchor、boundary curve、bbox、joint、symmetry、clearance 与 landmark contract，而不是只满足图片或文字相似度。[PartCrafter](https://arxiv.org/abs/2506.05573)、[CompoSE](https://arxiv.org/abs/2605.19350)

### 7.4 成本感知的动态 agent graph

研究何时值得分裂出新 worker、何时复用实例、何时串行、何时并行、何时放弃 diffusion 改用程序化方案。终止策略应以质量增量/成本、失败重复和依赖 invalidation 范围为依据，而不是固定“迭代十轮”。

### 7.5 医学/解剖场景的 ontology-constrained 版本

原稿举的线粒体例子存在一个知识性错误：线粒体没有细胞核；其关键结构包括外膜、内膜、膜间隙、嵴和基质。[NCBI Bookshelf：Mitochondria](https://www.ncbi.nlm.nih.gov/books/NBK9896/) 若用于医学教育，总管不应自由猜部件，而要读取 verified anatomy ontology、canonical part graph 和 landmark constraints；总监也不能只看逼真度，而要检查部件数量、包含关系、连接关系与关键地标。这里推荐 `verified geometry + generative presentation`，生成几何只能作为需审核的草模。

## 八、一个可验证的最小研究原型

不要一开始训练新 diffusion，也不要直接挑战复杂器官。可以用 3—6 个规则部件的硬表面对象做实验：凳子、抽屉柜、台灯或简化自行车。

### 8.1 基线与消融

| 实验 | 配置 | 要回答的问题 |
|---|---|---|
| B0 | 单 coding agent 写完整 Blender Python | 单 agent 的成功率、成本和典型错误是什么？ |
| B1 | 总管 + 多 part workers，无 critic loop | 分工本身是否改善部件与可执行性？ |
| B2 | B1 + `PartSpec`/bbox/anchor contract | 一致性提升来自 agent 数还是 contract？ |
| B3 | B2 + multi-view VLM critic | 视觉闭环能发现和修复哪些错误？ |
| B4 | B3 + deterministic geometry/physics gates | 纯 VLM 遗漏了多少 topology、collision、joint 问题？ |
| B5 | 对一个有机部件加入 3D diffusion worker | diffusion 是否提高局部质量，以及是否破坏接口？ |

### 8.2 指标

- task completion 与 Blender/GLB/URDF executability；
- part count、part labels 和 relation graph accuracy；
- bbox/OBB、anchor、joint、clearance 误差；
- non-manifold、self-intersection、watertight、degenerate faces；
- 多视图 semantic alignment、silhouette、normal/depth consistency；
- selective repair 成功率与 unaffected-part regression rate；
- tokens、GPU seconds、API cost、wall time、revision count；
- 人类偏好只能作为补充，不替代结构和几何指标。

### 8.3 最关键的研究假设

可以把论文假设写成：

> 在相同模型与计算预算下，`typed spatial/assembly contracts + localized verification + selective repair` 比自由自然语言多 agent 协作，更能提高复杂 3D 资产的装配正确率、局部可修复性和成本效率；为有机部件引入 diffusion worker 预计能提高视觉/几何细节，而 contract-conditioned generation 与确定性接口 gate 预计可降低破坏全局一致性的风险。两项都需要通过消融验证。

这个假设可以通过 B0—B5 做可重复消融，比“多 agent 是否更智能”更容易形成清晰贡献。

## 九、最终判断

### 路径一

**已具备可运行的研究原型与部分工程底座。** 最现实的形式是：coding agent 作为可审计 controller，调用现成 2D/multi-view/3D generator，保存所有配置和候选，用多视图 VLM + geometry/topology/physics tests 驱动 prompt search、局部重生成和 DCC 修复，最后按下游需求导出 mesh、GLB、3DGS 或其他表示。

它尚未解决的是：真实隐藏结构、production topology、稳定的局部编辑、3D reward 可靠性，以及 agent 自主后训练的成本和灾难性回归。

### 路径二

**关键组件基本齐备，完整体系仍处研究原型期。** 2026 年的 OpenTopos 已给出与原稿高度相似的开源实现，3D-GPT、LL3M、SceneWeaver、SAGE、PartCrafter、FullPart 等提供了学术支撑；但 P3D-Bench 与多智能体失败研究都说明，assembly、part-level structure、错误归因和终止仍是薄弱点。

真正值得研究的不是固定的“三层 AI 公司组织”，而是：

1. 总管如何编译 typed `AssetSpec`；
2. worker 如何在局部写权限下获得必要的全局条件；
3. assembler 如何确定性地组合异构表示；
4. 总监如何从多模态证据生成可执行 defect ticket；
5. 系统如何只返工受影响子图并证明无回归。

### 两条路径合并后的方向

> **Agentic 3D Compilation = structure-first planning + heterogeneous part builders + diffusion as a tool + deterministic assembly + multimodal critics + localized regression.**

这比“coding agent 直接续写 mesh”更符合截至 2026 年的研究趋势，也比“所有问题交给一个 diffusion 黑盒”更可编辑、可验证和可复现。

## 十、来源与证据说明

### 路径一：Diffusion、3D generator 与对齐

1. [DreamFusion: Text-to-3D using 2D Diffusion](https://arxiv.org/abs/2209.14988) — SDS 与逐对象 NeRF 优化的起点。
2. [Magic3D](https://research.nvidia.com/labs/cosmos-lab/magic3d/) — coarse-to-fine、NeRF 到 textured mesh。
3. [ProlificDreamer](https://arxiv.org/abs/2305.16213) — VSD，处理 SDS 过平滑、过饱和和低多样性。
4. [Fantasia3D](https://openaccess.thecvf.com/content/ICCV2023/html/Chen_Fantasia3D_Disentangling_Geometry_and_Appearance_for_High-quality_Text-to-3D_Content_Creation_ICCV_2023_paper.html) — geometry/appearance 解耦、DMTet 与 BRDF。
5. [MVDream](https://arxiv.org/abs/2308.16512) — camera-conditioned multi-view diffusion prior。
6. [DreamBooth3D](https://arxiv.org/abs/2303.13508) — 少图 subject personalization 与 3D 优化。
7. [Stable Fast 3D](https://arxiv.org/abs/2408.00653) — 快速 textured mesh reconstruction。
8. [TripoSR](https://arxiv.org/abs/2403.02151) — 单图快速 3D reconstruction。
9. [TRELLIS](https://arxiv.org/abs/2412.01506) — structured latent 与多表示 decoder。
10. [Hunyuan3D 2.0](https://arxiv.org/abs/2501.12202) — shape DiT 与 texture model。
11. [TripoSG](https://arxiv.org/abs/2502.06608) — rectified-flow 3D shape synthesis。
12. [PartCrafter](https://arxiv.org/abs/2506.05573) — compositional latent 与多部件 mesh。
13. [Native and Compact Structured Latents / O-Voxel](https://arxiv.org/abs/2512.14692) — 复杂 topology 与 PBR 属性的 structured representation。
14. [CompoSE](https://arxiv.org/abs/2605.19350) — part-aware synthesis 与局部编辑。
15. [GenArtist](https://arxiv.org/abs/2407.05600) — MLLM 调度图像生成/编辑工具并自我修正。
16. [DreamReward](https://arxiv.org/abs/2403.14613) — text-to-3D human preference reward。
17. [DreamCS](https://arxiv.org/abs/2506.09814) — geometry-aware 3D reward guidance。
18. [DDPO](https://arxiv.org/abs/2305.13301)、[Diffusion-DPO](https://arxiv.org/abs/2311.12908)、[D3PO](https://openaccess.thecvf.com/content/CVPR2024/html/Yang_Using_Human_Feedback_to_Fine-tune_Diffusion_Models_without_Any_Reward_CVPR_2024_paper.html) — diffusion preference/reward fine-tuning 的通用背景。

### 路径二：多智能体、部件化、3D agent 与评测

19. [3D-GPT](https://arxiv.org/abs/2310.12945) — task dispatch、conceptualization、modeling 三角色 procedural modeling。
20. [BlenderAlchemy](https://arxiv.org/abs/2404.17672) — VLM 驱动 Blender 编辑和状态评估。
21. [LL3M](https://arxiv.org/abs/2508.08228) — 多角色 Blender code、debug、视觉/代码 refinement。
22. [SceneWeaver](https://arxiv.org/abs/2509.20414) — standardized tool interface 与 self-reflective scene synthesis。
23. [SAGE](https://arxiv.org/abs/2602.10116) — generator orchestration、visual/physical critics 与 SAGE-10k。
24. [PartGen](https://arxiv.org/abs/2412.18608) — multi-view part segmentation、completion 与 reconstruction。
25. [AutoPartGen](https://proceedings.neurips.cc/paper_files/paper/2025/hash/e19b6f65791e350347bcff8a3955cb5b-Abstract-Conference.html) — autoregressive part generation/discovery。
26. [FullPart](https://proceedings.iclr.cc/paper_files/paper/2026/hash/4c2092ec0b1370cce3fb5965ab255fae-Abstract-Conference.html) — layout-first 与 per-part full-resolution generation。
27. [P3D-Bench](https://arxiv.org/abs/2606.11152) — parametric 3D、assembly 与 part-structure benchmark。
28. [OpenTopos](https://github.com/gaoypeng/opentopos)、[固定提交证据](https://github.com/gaoypeng/opentopos/blob/8c970a8f1ca2847d200cddcdfff2edb41130fbee/README.md#L17-L87) — 与原稿最接近的公开工程原型；非同行评审，项目方自报。
29. [MetaGPT](https://arxiv.org/abs/2308.00352)、[Mixture-of-Agents](https://arxiv.org/abs/2406.04692)、[Reflexion](https://arxiv.org/abs/2303.11366) — SOP、分层聚合和反馈记忆背景。
30. [Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657) — 14 类 MAS failure modes。
31. [Understanding Agent Scaling in LLM-Based Multi-Agent Systems via Diversity](https://arxiv.org/abs/2602.03794) — 同质扩张的边际收益与异构通道。
32. [T³Bench](https://arxiv.org/abs/2310.02977) — 多视图 text-to-3D 质量与对齐评测。
33. [MATE-3D / HyperScore](https://openaccess.thecvf.com/content/ICCV2025/papers/Zhang_Benchmarking_and_Learning_Multi-Dimensional_Quality_Evaluator_for_Text-to-3D_Generation_ICCV_2025_paper.pdf) — 多维 3D 质量评估。

### 官方接口与产品资料

34. [Meshy API](https://docs.meshy.ai/en) — text/image-to-3D、texture、remesh、animation API。
35. [Tripo OpenAPI](https://developers.tripo3d.com/en/docs/generation-image-to-model/standard) — 异步 image-to-model task 接口。
36. [Blender MCP Server](https://www.blender.org/lab/mcp-server/) — Blender 官方实验性 agent 接口与安全警告。
37. [NCBI Bookshelf: Mitochondria](https://www.ncbi.nlm.nih.gov/books/NBK9896/) — 线粒体外膜、内膜、膜间隙、嵴与基质的基础结构参考。

## 十一、方法说明

本次将问题拆成 8 个子问题：2D diffusion 如何监督 3D、原生 3D diffusion/flow 的进展、agent 工具调用、模型后训练与 reward、层级多智能体、3D 部件生成、critic/验证、成本与失败模式。主线程执行了 42 条检索查询，并使用两条并行研究链分别调查路径一和路径二；最终保留 37 组主要来源，优先选择论文原文、会议页面、官方项目、官方代码、API 文档与权威参考资料，并深读了 DreamFusion、TRELLIS、GenArtist、3D-GPT、LL3M、PartCrafter、CompoSE、SceneWeaver、SAGE、P3D-Bench、OpenTopos、DreamCS、多智能体失败与 agent scaling 等关键材料。

证据解释遵循三条规则：

- 论文中的速度、偏好和质量数字只解释为论文实验结果，不外推为通用 SLA；
- OpenTopos、Meshy、Tripo 等项目/产品能力以官方自述为证据，并明确区别于同行评审结论；
- “Agentic 3D Compiler”、typed contract、defect ticket、representation routing 和 MVP 设计是基于上述来源的综合推断，不声称已有单篇论文完整证明。
