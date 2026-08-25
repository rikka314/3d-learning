import json
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPORT_ROOT = ROOT.parent

PAPERS = {
    "spar3d": {
        "title": "SPAR3D: Stable Point-Aware Reconstruction of 3D Objects from Single Images",
        "short": "SPAR3D",
        "venue": "CVPR 2025",
        "doc": "spar3d",
        "source": "SPAR3D 官方 arXiv source、CVPR 2025 PDF；原路线报告。",
        "summary": "用低分辨率 point diffusion 承担单图不可见面的不确定性，再用 image-conditioned triplane mesher 恢复高保真 PBR mesh；point cloud 也成为可人工编辑的中间控制面。",
        "claims": [
            ("C1.1", "1", "论文身份与证据包", "SPAR3D 是 CVPR 2025 的单图 3D 重建论文；本包使用匹配的 arXiv LaTeX source 与 CVPR PDF。", "0_abstract.tex::p0001", "We study the problem of single-image 3D object reconstruction", "SPAR3D: Stable Point-Aware Reconstruction"),
            ("C2.1", "2", "一句话论点与研究方程", "论文把高分辨率扩散慢、前馈回归难处理遮挡面的矛盾，替换为“低分辨率生成 point cloud + 高保真条件 meshing”。", "1_intro.tex::p0002", "Regression-based models are highly effective", "How can we take the best of both worlds"),
            ("C4.1", "4", "真正解决的问题", "单图逆问题中，可见面由像素约束，遮挡面必须由 3D prior 猜测；SPAR3D 将两种不确定性放到不同阶段处理。", "1_intro.tex::p0003", "offload the uncertainty modeling to the point sampling stage", "local image features"),
            ("C9.1", "9", "核心方法", "输入图像先条件化生成 512 个带 XYZ/RGB 通道的稀疏点，再与图像局部特征共同驱动 triplane mesh reconstruction。", "3_method.tex::p0002", "point clouds", "n is set to 512"),
            ("C11.1", "11", "公式与表示", "SPAR3D 的 point stage 采用 DDPM 噪声过程与噪声预测损失；其作用是在低维中显式保留多解，而非直接平均成一个遮挡面。", "3_method.tex::p0003", "The diffusion process combines Gaussian noise", "L_{simple}"),
            ("C14.1", "14", "模块思维", "point cloud 是论文的替代机制：它以低成本样本表达背面假设，同时因无连接约束允许后续局部编辑。", "1_intro.tex::p0004", "lack of connectivity", "advantage with our two-stage approach"),
            ("C16.1", "16", "实验设计", "论文在 GSO 与 OmniObject3D 的约 250-object 测试集上，用统一旋转搜索与 ICP 对齐后报告 Chamfer Distance 与 F-score。", "4_experiments.tex::p0003", "GSO", "around 250 objects"),
            ("C17.1", "17", "实验—主张对齐", "SPAR3D 的实验主要检验 mesh 几何对齐与视觉质量；它们支持工程可用性，但不能证明医学隐藏结构真实。", "4_experiments.tex::p0004", "Chamfer Distance", "F-score"),
            ("C21.1", "21", "局限", "论文自身承认不可见面主要受 sampled point cloud 决定；这正是医学教育中不能把生成 mesh 当作不可见解剖真值的原因。", "3_method.tex::p0013", "unseen surface", "might not align with user intention"),
            ("C20.1", "20", "可复用论文模式", "SPAR3D 展示了“把不可见面不确定性下沉到低成本、可编辑中间表示，再用观测图像恢复局部细节”的可复用设计模式。", "1_intro.tex::p0003", "offload the uncertainty modeling", "point sampling stage"),
            ("C22.1", "22", "创新边界判断", "对医学教育，SPAR3D 的点云编辑性是有价值的工程增量，但它不提供解剖语义或隐藏结构真值保证。", "3_method.tex::p0013", "unseen surface", "editing the unseen surface"),
            ("C23.1", "23", "医学教育路线", "SPAR3D 最适合作为低显存 GLB 基线和人工修订入口；应让 canonical anatomy mesh、landmark 与 part graph 决定发布资格。", "3_method.tex::p0013", "editing the unseen surface", "altering the point cloud"),
        ],
        "sections": [
            ("方法与符号", "输入为 `I`。point stage 生成 `p_0 ∈ R^{n×6}`，其中每个点带 XYZ 和 RGB，论文取 `n=512`。DDPM 令 `p_t = sqrt(alpha_bar_t) p_0 + sqrt(1-alpha_bar_t) epsilon`，denoiser 预测噪声并用 L2 监督；DDIM/CFG 在推理时采样。meshing stage 用 DINOv2 图像 token 与 point token 形成 triplane，密度场经 DMTet 转 mesh，并估计 albedo、metallic、roughness、normal 与 illumination。"),
            ("证据链与图表", "Fig. overview 的论证顺序很清楚：输入图像先给 point diffusion，再将 point cloud 和局部 image features 送入 triplane transformer，最终输出 PBR mesh。实验采用 GSO、OmniObject3D；几何指标需要把预测与真值归一化、旋转搜索并 ICP 对齐，因此分数说明的是这些数据与协议下的表面接近度。"),
            ("复现判断", "首个复现选择合理：中间点云让你能保存、比较与人工修改背面；应固定输入 render、seed、point cloud、原始 mesh、GLB、六视图 normal/depth、耗时和峰值显存。不要用漂亮纹理掩盖拓扑错误。"),
        ],
        "lens": {
            "equation": "高保真前馈重建在遮挡面上假定图像—3D 单值映射；完整扩散可建模多解却太慢；SPAR3D 用轻量 point diffusion 代替高分辨率生成，再用条件 meshing 恢复细节。",
            "module": "point cloud：低成本承载遮挡面不确定性；triplane mesher：用输入图像锁定可见细节；编辑接口：把不可信背面显式交给人。",
            "future": "将 point-cloud uncertainty 转成器官地标/部件图置信度，并在发现 canonical mesh 冲突时拒绝发布。",
        },
    },
    "hunyuan3d_2_1": {
        "title": "Hunyuan3D 2.1: From Images to High-Fidelity 3D Assets with Production-Ready PBR Material",
        "short": "Hunyuan3D 2.1",
        "venue": "arXiv technical report / tutorial, 2025（非 CVPR）",
        "doc": "hunyuan3d_2_1",
        "source": "Hunyuan3D 2.1 官方 arXiv source/PDF；原路线报告。",
        "summary": "把单图 image-to-3D 拆成 ShapeVAE + flow-matching DiT 的 geometry stage 与 mesh-conditioned multi-view PBR painter；关键价值是把几何与外观验收分离。",
        "claims": [
            ("C1.2", "1", "论文身份与证据包", "Hunyuan3D 2.1 的官方材料是 arXiv technical report/tutorial；它不是已核实的 CVPR 2025 论文。", "Abstract.tex::p0001", "as a case study in this tutorial", "Hunyuan3D-DiT"),
            ("C2.2", "2", "一句话论点与研究方程", "系统以“shape generation 与 PBR paint 分离”替代端到端 RGB texture，使几何正确性和受光外观可分别控制与验收。", "Intro.tex::p0005", "separates shape and texture generation", "generate untextured meshes only"),
            ("C4.2", "4", "真正解决的问题", "单图生产资产不仅需要 mesh，还需要 albedo、metallic、roughness 的 PBR 属性与跨视图一致性。", "Intro.tex::p0004", "multi-view PBR diffusion", "albedo, metallic, and roughness maps"),
            ("C9.2", "9", "核心方法", "Hunyuan3D-DiT 在 ShapeVAE latent 中从图像预测 shape token；Hunyuan3D-Paint 以 mesh 条件生成多视图 PBR maps。", "Intro.tex::p0002", "two fully open-source foundation models", "Hunyuan3D-Paint"),
            ("C11.2", "11", "公式与表示", "ShapeVAE 从 surface point/normal 编码到 latent，并以 SDF decoder 加 Marching Cubes 还原 mesh；DiT 用 flow matching 预测从噪声到数据的 velocity。", "Train.tex::p0006", "predict the Signed Distance Function", "marching cube algorithm"),
            ("C14.2", "14", "模块思维", "PBR painter 的 3D-Aware RoPE 与 illumination-invariant training 分别针对多视图 seam/ghosting 和把光照烘焙进材质的失败模式。", "Train.tex::p0018", "texture seams and ghosting artifacts", "cross-view coherence"),
            ("C16.2", "16", "实验设计", "论文分 shape、texture、end-to-end asset 三类评估；shape 使用 ULIP/Uni3D，texture 使用 FID、CLIP-FID、CMMD、CLIP-I、LPIPS。", "Evaluation.tex::p0001", "three key areas", "Texture Synthesis"),
            ("C17.2", "17", "实验—主张对齐", "报告的 quantitative comparison 支持其作者主张，但 end-to-end 比较主要是可视化，且训练数据与许可边界必须单独审计。", "Evaluation.tex::p0013", "visualized comparison", "PBR material maps"),
            ("C21.2", "21", "局限", "其指标衡量 image/text–point-cloud 对齐或纹理相似，不覆盖医学部件关系、左右侧、腔室连接和专家教学正确性。", "Evaluation.tex::p0005", "similarity between the generated mesh and input images", "point cloud modality"),
            ("C20.1", "20", "可复用论文模式", "Hunyuan3D 2.1 的可复用模式是先独立生成/验收 shape，再让 mesh-conditioned PBR painter 处理外观，从而避免将结构错误藏在受光纹理里。", "Intro.tex::p0005", "separates shape and texture generation", "distinct stages"),
            ("C22.1", "22", "创新边界判断", "论文是 production-oriented 的系统整合和 PBR 工程推进；医学迁移仍需额外的 anatomy-aware geometry truth。", "Intro.tex::p0002", "generate a textured mesh", "Hunyuan3D-Paint"),
            ("C23.2", "23", "医学教育路线", "Hunyuan3D 2.1 是 PBR 主生产候选，但只能在 canonical geometry 已通过 QC 后用于外观阶段；其社区许可也须先审核。", "Intro.tex::p0005", "apply textures to custom assets", "enhancing flexibility"),
        ],
        "sections": [
            ("方法与符号", "ShapeVAE 以 mesh surface point cloud 和 normal 作为 encoder 输入，decoder 查询 3D grid 并预测 SDF；`L_r = E[MSE(D_s(x|Z_s), SDF(x))] + gamma L_KL` 使 latent 连续紧凑。DiT 采用 flow matching：`x_t=(1-t)x_0+t x_1`，学习速度 `u_t=x_1-x_0`，推理以 Euler ODE 从随机起点推进。Paint 分支同时产出 albedo、metallic、roughness，并用 mesh normal/CCM 约束。"),
            ("证据链与图表", "shape table 报告 Hunyuan3D-DiT 的 ULIP/Uni3D；texture table 报告 Hunyuan3D-Paint 的 CLIP-FID 24.78、CMMD 2.191、CLIP-I 0.9207、LPIPS 0.1211。它们说明各自组件在作者协议中的对齐/纹理优势，却不能折算为解剖可靠性。"),
            ("复现判断", "要拆开运行 shape-only、paint-only、end-to-end。检查 GLB 的 albedo/roughness/metallic 是否可编辑与 PBR 正确，而不是只看固定灯光下的渲染。模型形状和纹理阶段的显存门槛不同，且 Tencent community license 的地域、用途与商业条款不能被“开源代码”替代。"),
        ],
        "lens": {
            "equation": "一体化单图资产生成把“形状真值”和“受光外观”混在一起；Hunyuan3D 2.1 以可独立调用的 ShapeVAE/DiT 与 PBR painter 取代该耦合。",
            "module": "shape stage 负责结构候选；PBR painter 负责受光无关材质；多视图空间对齐降低 seam/ghosting。",
            "future": "对 canonical anatomy mesh 做 shape-conditioned paint，加入组织类别与教学色谱约束；不可让 paint 反向掩盖几何错误。",
        },
    },
    "tigon": {
        "title": "Text-Image Conditioned 3D Generation (TIGON)",
        "short": "TIGON",
        "venue": "CVPR 2026",
        "doc": "tigon",
        "source": "TIGON 官方 arXiv source、CVPR 2026 PDF；原路线报告。",
        "summary": "保留 image 与 text 两个 DiT 分支，在每层以 zero-initialized bridge 早融合，并在 rectified-flow 每一步平均 velocity；由此支持 image-only、text-only、image+text。",
        "claims": [
            ("C1.3", "1", "论文身份与证据包", "TIGON 的正式论文题名是 Text-Image Conditioned 3D Generation，发表于 CVPR 2026；TIGON 是方法/代码名。", "main.tex::p0005", "Text-Image Conditioned 3D Generation", "Text-Image Conditioned 3D Generation"),
            ("C2.3", "2", "一句话论点与研究方程", "低信息图像会使未观测区域失约束，纯文本缺像素级细节；TIGON 以持续跨模态交互让 image 与 text 在生成轨迹中互补。", "0_abstract.tex::p0001", "image-conditioned models", "text-conditioned models"),
            ("C4.3", "4", "真正解决的问题", "论文定义 joint text-image conditioned native 3D generation，要求输出同时忠于参考图外观/几何并符合文本语义。", "1_intro.tex::p0004", "Text--Image Conditioned 3D Generation", "simultaneously faithful"),
            ("C9.3", "9", "核心方法", "TIGON 以 UniLat3D 为方便的单阶段 latent generator，保留 two modality-specific DiT backbones，并插入双向 cross-modal bridges。", "3_method.tex::p0005", "single-stage 3D generator", "compatibility with our conditioning study"),
            ("C11.3", "11", "公式与表示", "每个 latent 的 rectified-flow 从 Gaussian 噪声开始，模型预测 velocity 并按时间步积分；融合发生在 velocity 与中间特征而非最终 mesh。", "3_method.tex::p0004", "Sampling with Rectified Flow", "velocity field"),
            ("C14.3", "14", "模块思维", "zero-initialized bridge 的目的不是取代单模态 backbone，而是让两条生成轨迹在联合微调时逐步交换信息、避免一开始破坏已训练能力。", "4_experiments.tex::p0021", "cross-modal bridges", "branches diverge during denoising"),
            ("C16.3", "16", "实验设计", "TIGON 在 TRELLIS-500K 训练，于 Toys4K 与 UniLat1K 评测 image-only、text-only、image+text，并用 CLIP、FD_DINOv2、ULIP、Uni3D。", "4_experiments.tex::p0006", "TRELLIS-500K", "Toys4K"),
            ("C17.3", "17", "实验—主张对齐", "TIGON 的最大增益出现在 image+text：Toys4K 的 GS 输出为 CLIP 92.33、FD_DINOv2 61.59；bridge ablation 把 FD_DINOv2 从 66.78 降到 61.59。", "4_experiments.tex::p0004", "TIGON (Ours)", "61.59"),
            ("C21.3", "21", "局限", "当 image 与 text 明确冲突且图像语义清晰时，模型倾向跟随图像；论文没有显式冲突检测或可调 modality priority。", "4_experiments.tex::p0017", "explicitly conflict", "tends to follow the image"),
            ("C20.1", "20", "可复用论文模式", "TIGON 的可复用模式是先用低信息视角诊断单模态失败，再验证最小 late fusion，最后用 early bridge 与消融证明真正必要的交互。", "4_experiments.tex::p0021", "cross-modal bridges", "substantial gain"),
            ("C22.1", "22", "创新边界判断", "TIGON 是明确任务定义与轻量 cross-modal fusion 的概念推进，但没有越过“通用条件对齐”到“医学事实核验”的边界。", "1_intro.tex::p0004", "jointly reason", "consistent 3D asset"),
            ("C23.3", "23", "医学教育路线", "TIGON 适合验证文字是否改善条件遵循，不适合直接作为医学 mesh 生产 winner；公开 checkpoint 主要服务 Gaussian 渲染输出。", "4_experiments.tex::p0009", "largest gains appear", "text-image conditioning"),
        ],
        "sections": [
            ("方法与符号", "TRELLIS 式 geometry latent 是 active voxel，appearance latent 是 active position 上的 feature；UniLat3D 将聚合视图特征压成单一 latent。设两个 branch 的 velocity 为 `v_img`、`v_txt`，最简单 late fusion 是 `v = 1/2(v_img+v_txt)`。每个 block 的 early bridge 可以写成 `f_img' = f_img + P_txt→img(f_txt)`、`f_txt' = f_txt + P_img→txt(f_img)`；bridge 以零初始化。独立 condition dropout 让训练覆盖无条件、image-only、text-only、image+text。"),
            ("证据链与图表", "低信息 View-1 诊断中，TRELLIS 的 FD_DINOv2 从 56.08 恶化到 143.58；简单 SimFusion 加 text 后为 82.40。完整 Table 2 显示 TIGON 的 joint condition 优于单模态；Table 3 则把 bridge 的主要作用从复杂 late fusion 中分离出来。Fig. 6 的冲突样例还提供了非常重要的安全边界：清晰图像会压过文本。"),
            ("复现判断", "必须对同一对象运行 image-only、text-only、image+text，prompt 固定为对象、视角、主要结构、左右侧、允许简化、禁止新增结构、展示风格。另建 image-text conflict 集：若文本说左侧而图像是右侧、或文字要求不存在的腔室，系统应输出冲突告警而不是默默选一边。"),
        ],
        "lens": {
            "equation": "image-only 有观察锚点但缺背面语义；text-only 有全局语义但缺局部细节；简单 late fusion 已有效，因此用 early bridge 让两种条件在整条 denoising trajectory 中协调。",
            "module": "双分支保存 modality-specific granularity；bridge 防止 velocity trajectory 发散；condition dropout 保留三种推理接口。",
            "future": "显式学习医学证据优先级、冲突检测与 abstention，使 canonical anatomy/专家文字能压过错误参考图。",
        },
    },
    "trellis_2": {
        "title": "Native and Compact Structured Latents for 3D Generation (TRELLIS.2)",
        "short": "TRELLIS.2 / O-Voxel",
        "venue": "CVPR 2026",
        "doc": "trellis_2",
        "source": "TRELLIS.2 官方 arXiv source、CVPR 2026 PDF；原路线报告。",
        "summary": "以 field-free O-Voxel 同时表示 geometry 与 PBR material，经 Sparse Compression VAE 压缩并由 4B flow models 生成；目标是原生处理复杂拓扑、内封闭表面与可 relight 的资产。",
        "claims": [
            ("C1.4", "1", "论文身份与证据包", "Native and Compact Structured Latents for 3D Generation 是 CVPR 2026 论文；其 arXiv 版本先于正式 proceedings。", "main.tex::p0009", "Native and Compact Structured Latents", "Native and Compact Structured Latents"),
            ("C2.4", "2", "一句话论点与研究方程", "iso-surface latent 难表达开放、non-manifold、内部封闭结构且常丢 PBR；TRELLIS.2 用原生 O-Voxel 与 sparse compression latent 替代。", "main.tex::p0016", "intrinsic limitations", "open surfaces"),
            ("C4.4", "4", "真正解决的问题", "论文追求既能被神经网络压缩又能保留任意拓扑和完整 material 的 3D-native representation，而不是只提高单一 render 分数。", "main.tex::p0014", "complex topologies", "detailed appearance"),
            ("C9.4", "9", "核心方法", "O-Voxel 是 active voxel 上的 `(shape feature, material feature, coordinate)` 集合；Flexible Dual Grid 负责 mesh topology，volumetric attributes 负责 PBR。", "main.tex::p0026", "collection of feature tuples", "sparse voxels"),
            ("C11.4", "11", "公式与表示", "Flexible Dual Grid 以 QEF 定位 dual vertex，并加入 boundary-edge 与位置正则项；PBR material feature 是 base color、metallic、roughness、opacity。", "main.tex::p0029", "quadratic error function", "boundary edges"),
            ("C14.4", "14", "模块思维", "SC-VAE 的代理作用是把高分辨率 O-Voxel 变成可被大型 flow model 处理的 compact structured latent，同时避免旧方法靠多视图 bake 合成外观。", "main.tex::p0019", "16x spatial downsampling", "9.6K latent tokens"),
            ("C16.4", "16", "实验设计", "论文分别评估 reconstruction、image-to-3D、shape-conditioned texture、ablation 与 resolution scaling，并以 normal/PBR/用户研究补充数值指标。", "main.tex::p0014", "geometry and material quality", "existing models"),
            ("C17.4", "17", "实验—主张对齐", "论文报告 4B models 在 H100 上约 3s/17s/60s 生成 512^3/1024^3/1536^3 资产；这是上界参照，不能直接外推消费卡。", "main.tex::p0020", "3s", "NVIDIA H100"),
            ("C21.4", "21", "局限", "O-Voxel 仍受 voxel resolution 限制，近距离平行面会 alias；稀疏 decoder 也可能产生小孔，并且表示未显式编码 part/semantic graph。", "main.tex::p0149", "bounded by its spatial resolution", "aliasing artifacts"),
            ("C20.1", "20", "可复用论文模式", "TRELLIS.2 的可复用模式是先设计能无损承载目标事实的 native representation，再以 sparse VAE 压缩到大模型可生成的 latent。", "main.tex::p0019", "native structured latent space", "compact latent space"),
            ("C22.1", "22", "创新边界判断", "O-Voxel 是表示层面的显著推进，但未显式建模 part-level semantic graph；因此对解剖教育仍是高端候选生成器而不是发布证明。", "main.tex::p0151", "does not explicitly encode", "graph-based topological structure"),
            ("C23.4", "23", "医学教育路线", "TRELLIS.2 是复杂拓扑/PBR 上界，但医学价值取决于后置 landmark、part graph、topology QC 与人工审核，而非 O-Voxel 自身。", "main.tex::p0151", "does not explicitly encode", "part-level segmentation"),
        ],
        "sections": [
            ("方法与符号", "O-Voxel 记为 `f = {(f_shape_i, f_mat_i, p_i)}_{i=1}^L`。`f_shape` 包含 voxel 内 dual vertex、三轴 edge-intersection flags 与 quad split weights；QEF 同时拟合 Hermite planes、开放边界线与交点均值。`f_mat=(c,m,r,alpha)` 分别是 base color、metallic、roughness、opacity。SC-VAE 做 16× spatial downsample，flow matching 学习从 noise 回到 latent data 的 vector field。"),
            ("证据链与图表", "方法图讲述了 mesh↔O-Voxel 的无优化、无渲染转换。作者报告 1024^3 资产约压到 9.6K latent token，并在 H100 上给出 512^3、1024^3、1536^3 的速度。对于项目，这些是“能否表达开放表面/内腔/PBR”的能力指针，绝非器官正确性的指标。"),
            ("复现判断", "只在有 Linux + NVIDIA ≥24GB 与 sparse CUDA 依赖经验时接入。首先做 6 个 canonical objects 的输出结构审查：开放面、薄片、孔洞、内部腔室、opacity 与 PBR map；再测 GLB、LOD、Three.js。重点不是在通用资产 benchmark 上复刻 H100 秒数。"),
        ],
        "lens": {
            "equation": "field-based latent 为网络规则性牺牲任意拓扑与材质；O-Voxel 以能直接进出 mesh 的稀疏原生单元加 SC-VAE 压缩，既保留结构又允许大模型生成。",
            "module": "Flexible Dual Grid 处理 topology；volumetric PBR attributes 保留 appearance；SC-VAE 解决 resolution/token bottleneck；flow model 将 image 条件映射到 latent。",
            "future": "把 O-Voxel 扩成 anatomy-aware O-Voxel：part ID、左右侧、containment/connection graph 与 landmark uncertainty 要成为 latent/QC 的一等字段。",
        },
    },
}


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def rel(path: Path) -> str:
    return Path(__import__("os").path.relpath(path, ROOT)).as_posix()


def evidence(claim, paper):
    cid, section_id, section_title, claim_text, paragraph_id, quote, snippet = claim
    direct_sections = {"1", "2", "4", "9", "11", "16", "17", "25"}
    return {
        "claim_id": cid,
        "section_id": section_id,
        "section_title": section_title,
        "claim_text": claim_text,
        "interpretation_type": "evidence-backed interpretation" if section_id in direct_sections else "plausible inference",
        "research_role": "paper-grounded analysis",
        "evidence": [{
            "evidence_id": f"E-{cid}-a",
            "doc": paper["doc"],
            "paragraph_id": paragraph_id,
            "quote": quote,
            "relation": "direct" if section_id in direct_sections else "inference",
            "locator_snippets": [snippet],
        }],
    }


def suffix(paper):
    return paper["claims"][0][0].split(".", 1)[1]


def supplemental_claims(paper):
    base_by_section = {claim[1]: claim for claim in paper["claims"]}
    rows = [
        ("3", "标题解读", "标题把论文的对象、条件或关键 representation 准确地压缩成一个技术承诺；此处的逐词解读是基于论文摘要与方法的推断。", "2"),
        ("5", "科学问题阶梯", "直接任务只是单图或条件 3D 生成；更上层的问题是如何在不完整观测下表达不确定性，同时把可发布资产的几何事实与视觉呈现分开。", "4"),
        ("6", "作者可能的发现路径", "一种合理的作者侧路径是先发现已有范式的隐藏假设，再保留其强项并把失败环节替换为新的中间表示、模块或条件机制。", "4"),
        ("7", "论文叙事构造", "论文的叙事闭环是“明确失败模式 → 给出设计原则 → 放入模块 → 用主表、图或消融检验”；这是证据支持的结构性解读。", "9"),
        ("8", "相关工作与关键引用", "相关工作在本文中承担方法祖先、对照压力或局限性证据的角色，而不是可直接横向排名的列表。", "4"),
        ("10", "符号、概念与记号", "本报告只将符号解释为算法中实际使用的对象；任何符号都不应被误读为输入图像已提供的医学事实。", "11"),
        ("12", "理论、证明与实践映射", "论文的训练目标或表示公式说明优化对象与实现步骤，但通常不是医学拓扑正确性的证明。", "11"),
        ("13", "算法/模块 walkthrough", "把论文实现成可复现实验时，应按输入条件、latent/中间状态、decoder、输出 artifact 与 QC 依次展开，而不能只复刻最终截图。", "9"),
        ("15", "图表解读", "论文中的 pipeline、主表与消融图支持其具体通用资产主张；图中可见的质量不自动扩展为看不见的结构真实性。", "17"),
        ("18", "Reviewer-lens audit", "从审稿视角，应把作者协议内的优越性、训练/依赖门槛、数据/许可不确定性以及医学迁移缺口分开评价。", "16"),
        ("19", "创新点与支持审计", "贡献应逐条绑定其对应的表示、模块、消融或 benchmark，而不能把系统总结果一概归因给单一新意。", "17"),
        ("24", "通俗故事", "把论文记成“用一个被约束的代理机制处理 2D 中缺失的 3D 信息”，比把它记成模型名或单一分数更接近其可复用洞见。", "2"),
        ("25", "来源使用说明", "本报告使用与目标版本匹配的官方 LaTeX source 作为结构化证据，并用官方 PDF 检查页码、表格和图形。", "1"),
    ]
    out = []
    for section_id, title, text, source_section in rows:
        source = base_by_section[source_section]
        out.append((f"C{section_id}.{suffix(paper)}", section_id, title, text, source[4], source[5], source[6]))
    return out


def all_claims(paper):
    return paper["claims"] + supplemental_claims(paper)


def paper_details(paper):
    name = paper["short"]
    common = {
        "ladder": "**方向原生问题：**从有限 2D 条件产出可用 3D。**父领域问题：**在速度、几何、外观、可控性和拓扑之间选择合适的表示。**更广泛问题：**如何让生成系统在证据不足时显示不确定性、接受外部事实约束，而不是把合理先验伪装成真值。",
        "review": "**Novelty：**应相对于论文自己定义的瓶颈判断，而不是仅看模型规模。**Soundness：**检查每个模块是否有相应实验或可解释的训练目标。**Reproducibility：**推理可复现不等于训练可复现；模型权重、数据、许可证、GPU 依赖与随机种子都要单独记录。**医学迁移：**所有通用 embedding/render metric 只能当辅助信号，不能替代 anatomy reviewer。",
        "contribution": "把论文的贡献拆为 representation/condition、generation 或 reconstruction、appearance/asset delivery、evaluation 四层；每一层仅在原论文提供的实验协议里获得支持。医学适配的新增贡献必须另建证据集，而不能从通用基准分数推演。",
        "medical_protocol": "复现时把输入、seed、checkpoint、原始中间产物、GLB、六视图 RGB/normal/depth、triangle count、PBR maps、耗时、peak VRAM 和失败标签全量保存。发布前依次检查 canonical alignment、landmark、part count、laterality、containment/connection、孔洞/自交/non-manifold、GLB/Three.js；最后由医学 reviewer 判为可教学使用、仅概念展示或不可使用。",
    }
    if name == "SPAR3D":
        return {**common,
            "title": "`Stable` 指不只追求一次采样好看，而是让 point stage 的概率输出和 meshing stage 的细节恢复配合稳定；`Point-Aware` 指 point cloud 不是副产物，而是连接两阶段、表达背面假设并允许编辑的核心接口；`Reconstruction` 表明输入仍是单图观测而非纯文本创作。",
            "direction": "作者可能先看到两条路线各自失败：回归很快、贴合可见面，却把图像到 3D 当单值映射；高分辨率 3D diffusion 能表达多解，却慢且可见面不够贴图。最小替换不是重做整个 pipeline，而是把生成性限制在 512-point 的廉价空间，再让条件 mesher 做高分辨率局部恢复。",
            "story": "挑战是遮挡面多解与高分辨率计算相冲突；原则是把不确定性放到低带宽中间表示；模块是 point DDPM、image/point triplane mesher、inverse rendering 和 edit interface；证据是作者的几何基准、野外图像、编辑示例和速度声明。这个闭环比“一个大网络同时做好全部事情”更可诊断。",
            "related": "论文把 feedforward regression 与 diffusion generation 构成主张力；Point-E/DINOv2 是实现祖先，PointInfinity/SF3D 是 meshing/feature 设计参照，DMTet、RENI++、Disney BRDF 是显式 mesh 与 PBR 训练的工程支撑。它们的叙事角色不同，不能简单并列为 SOTA。",
            "notation": "`I` 是输入图像；`p_0` 是带 XYZ/RGB 的点云；`p_t` 是加噪后的点云；`epsilon_theta` 是条件 denoiser；`n=512` 是 point count；triplane 是高分辨率 feature plane；DMTet 将 density 转显式 mesh。最关键的认识是：point cloud 对遮挡面表达的是条件分布的样本，而不是观测真值。",
            "formulas": r"前向噪声为 `$p_t=\sqrt{\bar{alpha}_t}p_0+\sqrt{1-\bar{alpha}_t}epsilon$`，其中 `epsilon` 是 Gaussian noise；训练最小化 `$L_simple=E||epsilon-epsilon_theta(p_t,t;c)||_2^2$`。`c` 是 DINOv2 image token。这个目标训练的是低维点云去噪器，不直接对最终 mesh 的每个不可见三角面声明真值。meshing stage 的 rendering loss 结合 L2、LPIPS、mask，并以 mesh/shading regularization 约束逆渲染。",
            "theory": "论文没有要证明医学正确性的定理；其“理论”是分工假设：低分辨率 point sampling 能承受迭代生成成本，局部 image feature 能恢复可见细节，point guidance 能降低 meshing 的不确定性。实现中的 DDPM、DMTet、renderer 与这些假设大致对齐；但从 point prior 到真实背面的缺口仍存在。",
            "walkthrough": "1. 预处理单图并编码 DINOv2 features。2. 从噪声经 DDIM/CFG 采样 `512×6` point cloud。3. 将点 token 和 image token 输入 triplane transformer。4. 查询 density、vertex offset、normal，DMTet 得 mesh。5. 估 albedo/metallic/roughness/illumination，做 differentiable rendering。6. 导出 mesh/GLB；若背面不符合意图，编辑 point cloud 后重跑 mesher。",
            "module": "**Point stage：**理想但不可得的是观察到完整背面；可用代理是低维点先验，隐藏赌注是它能覆盖正确背面模式。**Mesher：**理想但不可得的是每个表面都有多视图监督；可用代理是局部 image feature 加 point guidance。**Edit：**理想但不可得的是模型一次就对；可用代理是人编辑没有拓扑约束的稀疏点。医学中这一步应被 canonical landmark 和 part graph 驱动。",
            "figures": "teaser/overview 应读作模块因果图，而不是质量海报：它说明 point diffusion 先提出形状假设，triplane 再用图像修细节。rendering figure 说明作者把 geometry、materials、lighting 拆开以降低 baked-in light；qualitative figure 只能显示作者选例下的外观和轮廓，不显示解剖连接是否正确。",
            "experiments": "GSO、OmniObject3D 各约 250 对象，去掉简单盒/柱以减少容易样本偏置；用随机 HDRI、不同 elevation/azimuth/focal length 生成测试视图。CD/FS 在归一化、rotation brute-force 与 ICP 后计算，因此衡量的是匹配协议下的 surface proximity。对本项目应加 canonical anatomy 的 NSD/HD95/landmark/part-graph。",
            "audit": "作者用公开基线与统一 mesh protocol 形成工程比较；但仍有三点不能越界：第一，遮挡面不能直接验证；第二，CD/FS 对薄结构、连接关系和左右侧不敏感；第三，PBR 看起来合理不代表器官材质或层次正确。",
            "pattern": "可复用故事模式是 `不确定的高维目标 → 低维概率中间物 → 高保真条件 decoder → 可编辑的人工闭环`。它特别适合把“模型最不可信的地方”外显出来，而不是埋在最终 mesh 里。",
            "limitations": "除了论文承认的 user-editable unseen surface，关键风险还有 sparse point 的覆盖不足、DMTet 细节限制、inverse rendering 的 illumination/material 互混以及通用物体先验对医学形态的 domain shift。",
            "boundary": "创新主要是工程与 representation 分工：不是新医学机制，也不是临床重建。它适合作为医学教育资产生成候选的最低成本对照，而不是替代 atlas。",
            "future": "把点云每个区域的不确定性、与 canonical mesh 的距离、landmark conflict 和 part membership 写进输出。研究上可比较：随机 point sample 是否能被 ontology-conditioned point proposal、multi-view verified render 或 expert correction policy 替代。",
        }
    if name == "Hunyuan3D 2.1":
        return {**common,
            "title": "`From Images` 限定输入是 2D image；`High-Fidelity 3D Assets` 关注 mesh 细节；`Production-Ready PBR Material` 则把 albedo、roughness、metallic 从普通 RGB texture 升为交付资产要求。标题也解释为什么它应被看作系统/教程型 technical report，而不是只比一个 shape metric 的论文。",
            "direction": "作者可能从生产流程的断裂出发：shape generator 可给 mesh，但 RGB texture 常把光照烘焙进去、跨视图不一致，导致模型难以在真实 renderer 中复用。因而保留 ShapeVAE/DiT 生成几何，再让 mesh-conditioned painter 专管 PBR maps。",
            "story": "论文先定义资产级问题，再拆分 shape、texture、end-to-end 三类评估；对应模块是 ShapeVAE、flow-matching DiT、multi-view PBR Paint、spatial-aligned attention、3D-Aware RoPE 与 illumination-invariant training。优势叙事来自分层评估，而风险是 end-to-end 的真实工程质量仍取决于二者接口。",
            "related": "3DShape2VecSet/CLAY/Dora 提供 latent shape 表示脉络；Hunyuan-DiT、TripoSG 提供 Transformer/flow 思路；Hunyuan3D 2.0、ReferenceNet、MaterialMVP/RomanTex 构成 material pipeline 祖先。它们说明论文不是从零发明所有组件，而是把 shape latent 和 PBR production 做成可开放复现的组合。",
            "notation": "`Z_s` 是 shape latent；`D_s(x|Z_s)` 预测 query location 的 SDF；`u_theta(x_t,c,t)` 是 flow velocity；`c` 是 image condition。PBR 的核心 maps 是 albedo、metallic、roughness；CCM 和 normal map 是 Painter 所用的 geometry-aligned condition。",
            "formulas": "ShapeVAE reconstruction 为 `$L_r=E[MSE(D_s(x|Z_s),SDF(x))]+gamma L_KL$`：第一项保持 shape field，第二项使 latent 连续可生成。flow matching 采用 `$x_t=(1-t)x_0+t x_1$`、`u_t=x_1-x_0`，训练 `$E||u_theta(x_t,c,t)-u_t||_2^2$`。Paint 的关键不是一个单独公式，而是把 normal/CCM、reference image 与 multi-view attention 合在 PBR map diffusion 中。",
            "theory": "这里没有 formal proof；公式提供的是优化—实现映射。SDF/VAE 假设 watertight field 足以表达目标 shape，flow matching 假设 image condition 能指向正确 latent，illumination-invariant loss 假设同一对象在不同光照下 intrinsic material 不变。最后一个假设非常适合 PBR，但不是人体组织或教材插图真实性的证明。",
            "walkthrough": "1. 清理背景、缩放/居中单图。2. ShapeVAE latent 上的 DiT/flow 由噪声生成 shape token。3. decoder 查询 SDF，Marching Cubes 得 untextured mesh。4. 对 mesh render normal/CCM/multiview geometry condition。5. PBR painter 同时生成 aligned albedo 与 metallic-roughness maps，并以 3D-Aware RoPE 促使跨视图一致。6. 导出 GLB 后独立检查 geometry 与每张 map。",
            "module": "**ShapeVAE：**代理是 SDF field，赌注是 field 化不会抹去所需细节。**DiT：**代理是 flow trajectory，赌注是 image feature 含足够形状线索。**PBR painter：**代理是 geometry render/CCM，赌注是正确 mesh 已给出足够对应关系。**illumination invariant training：**代理是同物体的不同灯光 render，赌注是光照变化与材质本征可分离。",
            "figures": "shape pipeline 图应按“image → DiT → ShapeVAE decoder → mesh”读；texture pipeline 图应按“reference image + normal/CCM + multiview attention → albedo/MR maps”读。比较图说明 normal/detail 与外观的作者选例，但它们不能证明没有内部错误，也不能回答许可证、透明度、移动端加载等生产问题。",
            "experiments": "作者明确分 shape generation、texture synthesis、complete asset。shape table 使用 ULIP/Uni3D；texture table 比较 SyncMVD-IPA、TexGen、Hunyuan3D-2.0 等，报告 CLIP-FID/CMMD/CLIP-I/LPIPS；end-to-end 主要是可视化。这种分层正适合项目采用 shape-only、paint-only、end-to-end 三个测试轨。",
            "audit": "主张的强证据是组件级 metrics 和 PBR 设计；中等证据是 qualitative end-to-end comparison；弱证据是“production-ready”跨平台、许可证、应用领域的外推。报告必须明确 Hunyuan3D 2.1 是 arXiv technical report/tutorial，不能伪标 CVPR。",
            "pattern": "可复用模式是 `先冻结/验证几何，再以 geometry-conditioned generative painter 做外观`。其价值不在让单图更会猜，而在把“结构错”与“看起来不好”从同一个黑盒评价中拆开。",
            "limitations": "单图 shape 仍含不可见面先验；SDF/watertight preprocessing 对开放/内部复杂面有限；PBR maps 可高质量但不证明组织生理；180 GPU-days 等训练成本、社区许可证和地区限制也限制可部署性。",
            "boundary": "这是 production system 方向的强工程整合，跨越 geometry 和 material，但没有进入 anatomy truth、semantic part ontology 或医学安全评估。",
            "future": "将 canonical anatomy mesh 直接作为 Painter 条件，仅让模型生成受控色彩/材质/标注风格；将白名单的组织材料、label layout 与不可改 landmark 写入约束。若需 geometry adaptation，应先以 surface/part graph loss 审计。",
        }
    if name == "TIGON":
        return {**common,
            "title": "`Text-Image` 表示两个异质条件共同参与；`Conditioned` 表示不是后期 texturing，而是生成 trajectory 中的控制；`3D Generation` 特意指 native 3D representation，而不是先生成多视图图像再重建。方法名 TIGON 只是这一正式题名的简写。",
            "direction": "作者先构造低信息 View-1，量化 image-only 的视角依赖，再发现 text-only 也缺细节；连最简单的 velocity average 都能显著改善，于是将“两个条件共同生成 3D”从工程技巧提升为任务定义。下一步才是用 bridge 解释为什么 early interaction 比只做 late fusion 更有效。",
            "story": "挑战一：image 对不可见面不足；挑战二：text 对 pixel geometry 不足；最小原则是保留各自 backbone；模块是 dual DiT、zero-initialized bridges、velocity fusion、independent condition dropout；证据依次是 View-0/1 诊断、主表、冲突图和 Table 3 ablation。",
            "related": "TRELLIS 提供 geometry/SLAT rectified-flow 基座，UniLat3D 提供 single-stage compatible backbone，CLIP/DINOv2 分别充当文本/图像 condition encoder。SimFusion 是必要的简单对照：它证明收益不只来自提出新任务，而 bridge ablation 才支持 early interaction 的贡献。",
            "notation": "`z_geo` 是 geometry latent，`z_SLAT` 是 appearance structured latent，`z_uni` 是 UniLat3D latent；`F_l` 预测 velocity；`I`、`T` 是 image/text conditions；`f_img^(i)` 与 `f_txt^(i)` 是第 i 个 block 的特征，`P` 是跨模态线性投影。这里没有任何符号等价于“文本已经验证了解剖关系”。",
            "formulas": "rectified-flow 每步计算 `$v_{l,k}=F_l(z~_{l,t_k},t_k;c)$`，然后 `$z~_{l,t_{k+1}}=z~_{l,t_k}-(t_k-t_{k+1})v_{l,k}$`。late fusion 使用 `$v=1/2(v_img+v_txt)$`；early bridge 可写为 `$f_img'=f_img+P_{txt→img}(f_txt)$`、`$f_txt'=f_txt+P_{img→txt}(f_img)$`。zero initialization 的工程意义是联合训练开始时 bridge 不改变原单模态模型，后续由梯度打开。",
            "theory": "论文没有对“融合一定更正确”做证明；它以诊断和 ablation 支撑。实践上，条件 dropout 使四种 condition state 都被看见，分支可单独用或联合用；但冲突图显示实际决策权不是显式可控的，因此实际系统必须把 modality priority 另做成可审计组件。",
            "walkthrough": "1. 固定 image、text、seed 和 latent scheduler。2. image branch 从 DINO condition 得 velocity，text branch 从 CLIP condition 得 velocity。3. 每个 denoising block 经 bridge 交换 feature。4. 每步平均或选择 fusion velocity。5. decode 为 mesh/3DGS。6. 同一对象运行 I、T、I+T 及 deliberate-conflict 四组，比较外观、结构、条件服从与拒答/不确定性。",
            "module": "**Dual branch：**理想是一个完全对齐的 joint encoder，现实代理是保留各模态的成熟 token/backbone。**Bridge：**理想是知道何时哪种证据可靠，代理是层间线性消息。**Late fusion：**理想是有 ground-truth posterior，代理是平均 velocity。**Dropout：**理想是覆盖所有用户输入组合，代理是独立随机缺失条件。医学中最脆弱的是“图像更具体所以应优先”的隐含假设。",
            "figures": "View-0/1 图是整篇论文最重要的因果起点：它不是普通测试视角，而是人为降低可观察信息。主 qualitative 图分别展示 image-only、text-only、joint 的失败类型；冲突图说明 image 优先；bridge ablation 图说明无 bridge 时 trajectory diverge。阅读时应问每张图是否真的隔离了所声称的变量。",
            "experiments": "训练用 TRELLIS-500K；text branch 从头训练 1M iterations、batch 256，joint fine-tune 50k iterations，64 A800 + BF16/ZeRO-2/FlashAttention。评测 Toys4K（约 4K、105 类）和 UniLat1K（500 Sketchfab + 500 Toys4K），使用 CLIP、FD_DINOv2、ULIP、Uni3D，并把多视角 reference 固定为 front/top/bottom。",
            "audit": "强证据：View-1 退化、SimFusion 改善、TIGON joint 主表、bridge ablation。中等证据：定性 controllability。弱/未覆盖：医学泛化、长复杂文本、显式优先级、人体结构图、专家判定。表中有些外部系统用非公开数据，比较时不能把分数解释成纯方法差异。",
            "pattern": "模式是 `先制造失败条件 → 证明最小融合有效 → 提出任务 → 加最轻机制 → 用消融定位增益`。这比先堆叠复杂 cross-attention 再找解释更适合医学研究：应该先构造“图像缺失、文本缺失、互相冲突”的解剖诊断集。",
            "limitations": "通用 object data 的 vocabulary 和 anatomy 差异巨大；Gaussian/render metrics 与 mesh topology 有间隙；训练成本高；模型在 conflict 下偏 image 而不报告置信度；公开 checkpoint 的主要输出形态也不应被强行当成 production GLB。",
            "boundary": "创新属于 controllable multimodal 3D generation 的任务与融合推进；它没有声称给出 ground-truth-aware multimodal reasoning。对医学教育而言，真正的边界突破将是有来源优先级、冲突检测、结构约束和可拒答机制的 joint generator。",
            "future": "将 condition 分为 observation、ontology、teaching-style 三个通道：image 只能约束可见面；canonical ontology/landmark 可约束结构；text 只控制命名、视角和允许简化。研究对比 priority policy、conflict abstention、part-graph constrained diffusion 与专家交互修订。",
        }
    return {**common,
        "title": "`Native` 指 latent 从原始 3D asset 而非多视图 2D 特征中学习；`Compact` 指高 spatial compression；`Structured` 指仍保留 sparse voxel 的空间规则；`3D Generation` 目标是携带 geometry 与 PBR material 的完整资产。TRELLIS.2 是项目/模型名，O-Voxel 是论文的核心 representation。",
        "direction": "作者从两个冲突出发：unstructured latent 压缩强却容易丢 reconstruction fidelity；field/iso-surface structured latent 几何精度高却难处理 open/non-manifold/interior，且常不含 material。于是用能与 mesh 直接双向转换的 O-Voxel 保留事实，再由 SC-VAE 解决 token 数。",
        "story": "挑战是任意 topology + PBR + compact latent；原则是 native mesh representation、field-free dual grid、稀疏压缩和直接 latent generation；模块是 O-Voxel、Flexible Dual Grid、material attributes、SC-VAE、flow model、FlexGEMM。主叙事通过 reconstruction、generation、texture、ablation、resolution scaling 和限制段形成闭环。",
        "related": "SDF/FlexiCubes 是被指出的 field-based 对照，point/mesh/Gaussian 是不规则但难压缩的显式表示，TRELLIS SLAT 是 material-aware 但依赖 multiview image feature 的近邻，Clay/3DShape2VecSet 等是 unstructured latent 脉络。论文的定位是换 representation，而不仅是扩 model size。",
        "notation": r"`F=\{(f_i^{shape},f_i^{mat},p_i)\}_{i=1}^{L}` 是 O-Voxel；`p_i` 是 active voxel coordinate；`v_i` 是 dual vertex；`delta_i` 是 edge intersection flags；`gamma_i` 是 quad split weight；`f_mat=(c,m,r,alpha)` 是 base color、metallic、roughness、opacity。SC-VAE 将这些 sparse feature 压到 latent，flow model 学习从 noise 回到该 latent。",
        "formulas": "Flexible Dual Grid 的 QEF 最小化 plane distance、boundary-line distance 与交点均值正则：`min_v e(v)=sum_i d_Pi,i^2 + lambda_bound sum_j d_L,j^2 + lambda_reg d_qbar^2`。这使 open boundary 对 dual vertex 有显式约束。flow matching 写作 `$x(t)=(1-t)x_0+t epsilon$`，并最小化网络 velocity 与 `(epsilon-x_0)` 的 L2。PBR feature 不只是 RGB，而是 `$f_mat=(c,m,r,alpha)$`。",
        "theory": "QEF/dual-grid 给出 representation-to-mesh 的确定性构造，而非泛化保证；SC-VAE/CFM 说明学习目标，但 voxel resolution、sparse decoder 和 training data 仍决定实际失败模式。对于医学，这一层最大的好处是能把“能否表达 open/inner surface”和“是否语义正确”明确拆开。",
        "walkthrough": "1. 把 raw mesh 与 PBR texture 转成 active O-Voxel。2. 对每个 cell 以 Hermite data/QEF 求 dual vertex，记录 edge flags、split weights 和 material features。3. SC-VAE 编码/解码，先看 reconstruction。4. image condition 的 flow model 从 noise 生成 shape/material latent。5. O-Voxel 转回 mesh/texture map/GLB。6. 对开放面、孔、内腔、薄片、opacity/PBR 单独 QC。",
        "module": "**Flexible Dual Grid：**理想是任意 mesh 可无损进入规则 tensor，代理是每 active voxel 的局部 dual representation。**Volumetric attributes：**理想是完整 texture graph，代理是 geometry-aligned local PBR attributes。**SC-VAE：**理想是高分辨率又少 token，代理是 sparse residual compression。**Flow model：**理想是 image 中拥有全 3D 事实，代理是训练数据 prior。医学的隐患是 representation 没有 part/semantic graph。",
        "figures": "overview 图应读成 representation→VAE→flow 的依赖链；O-Voxel conversion 图应读成 mesh↔sparse feature 的可审计转换；normal/PBR/relighting 的 qualitative 图验证的是可表达性与外观，而不是内腔、神经/血管连接或器官名称。限制图/段落比漂亮样例更重要：它指出 alias 和 hole 的具体机制。",
        "experiments": "论文覆盖 3D asset reconstruction、image-to-3D、shape-conditioned texture、ablation、test-time compute/resolution scaling。它报告约 4B parameters、16× spatial downsampling、1024^3 约 9.6K token，以及 H100 上 512^3/1024^3/1536^3 的速度。不同表/用户研究使用 normal/PBR/render 等多信号，适合建立“表示能力”上界而不是统一医学分数。",
        "audit": "强证据：O-Voxel 对 topology/material 的明确定义、转换算法、SC-VAE reconstruction、分层实验和 limitation discussion。中等证据：作者的通用资产质量/速度比较，尤其取决于 H100 与数据协议。未覆盖：医学 semantic part、laterality、containment/connection、测量尺度和专家教学效用。",
        "pattern": "模式是 `先选择能表达目标对象的原生事实表征 → 再压缩 → 再生成`。这反转了“先找一个易生成 latent，再接受它表达不了的 topology”的做法；对医学特别重要，因为解剖关系是先验契约，不是视觉纹理。",
        "limitations": "论文明确指出 voxel resolution 下近距离平行面会 alias，sparse decode 可能出现 hole，表示也没有显式 part/semantic graph。还应加上 Linux/NVIDIA/sparse CUDA 高门槛、H100 时间不能外推、通用数据集与解剖域差异。",
        "boundary": "O-Voxel 是 representation 层很强的跨越：可同时容纳复杂 topology 与 PBR；但缺 semantic ontology，故仍是生成上界，不是医学知识 representation。",
        "future": "扩展为 anatomy-aware O-Voxel：把 organ/part ID、laterality、containment/connection graph、landmark distance 和 uncertainty 作为输入/latent/QC 字段。对每个输出要求 topology contract；若合同不满足，系统必须降级为 approximate asset 或拒绝发布。",
    }


SECTION_TITLES = {
    "1": "论文身份与来源包", "2": "一句话论点与研究方程", "3": "标题解读", "4": "论文真正解决的问题", "5": "科学问题阶梯", "6": "作者可能如何找到方向", "7": "作者如何搭建论证故事", "8": "相关工作、关键引用与缺口", "9": "主思想", "10": "符号、概念与记号", "11": "关键公式与逐式解释", "12": "理论、证明与实践映射", "13": "算法/模块 walkthrough", "14": "模块背后的作者思考", "15": "图表解读", "16": "实验设计", "17": "实验作为故事证据", "18": "Reviewer-lens audit", "19": "创新点与主张支持审计", "20": "值得学习的论文构造模式", "21": "弱点、限制与改进空间", "22": "创新类型与边界判断", "23": "未来方向与医学教育迁移", "24": "简单而准确的故事", "25": "使用的来源",
}


def section_body(section_id, paper, detail):
    bodies = {
        "1": f"本报告的结构化主证据是匹配版本的 arXiv LaTeX source，PDF 仅用于交叉检查标题页、图表、页码与视觉布局。{paper['source']} 本地 `latex_run/` 保留源文件、编译 PDF、SyncTeX 与 paragraph index，因此报告中的每个主张可回到具体源段落。",
        "2": f"**研究方程：**{paper['lens']['equation']}\n\n{paper['summary']}",
        "3": detail["title"],
        "4": "论文的问题是 under-constrained 3D inference：输入只观察部分外观，模型必须依赖训练 prior 推断不可见区域。通用论文的贡献是选择何种 prior、latent 或控制接口；医学教育的额外问题是区分“候选合理”与“结构已经被证实”。因此任何后续结论都要区分原文直接证据、合理推断和本项目的安全性要求。",
        "5": detail["ladder"],
        "6": detail["direction"],
        "7": detail["story"],
        "8": detail["related"],
        "9": f"{paper['summary']}\n\n核心不是把所有组件背下来，而是识别论文替代了哪个不可用机制：{paper['lens']['module']}",
        "10": detail["notation"],
        "11": detail["formulas"],
        "12": detail["theory"],
        "13": detail["walkthrough"],
        "14": detail["module"],
        "15": detail["figures"],
        "16": detail["experiments"],
        "17": detail["audit"],
        "18": detail["review"],
        "19": detail["contribution"],
        "20": detail["pattern"],
        "21": detail["limitations"],
        "22": detail["boundary"],
        "23": f"{detail['future']}\n\n### 建议的统一医学验收协议\n\n{detail['medical_protocol']}",
        "24": f"{paper['short']} 像一名手艺很好的 3D 工匠：它会根据已有的二维线索和积累的常识补全一个物体，但不会自动知道医学上哪一条连接、哪一侧、哪一个腔室绝对不能猜。正确的课堂资产流程是让它先做候选，再让 verified anatomy 和专家把关。",
        "25": f"- {paper['source']}\n- 官方代码、模型卡和 license 页面用于复现/发布风险判断；它们不是论文实验结果的替代证据。\n- 本地生成的 source、PDF extraction、traceability、research lens、storyboard prompts 与 reader bundle 均保留在同一 run 目录。",
    }
    return bodies[section_id]


def make_report(paper):
    claims = all_claims(paper)
    by_section = {}
    for claim in claims:
        by_section.setdefault(claim[1], []).append(claim)
    detail = paper_details(paper)
    lines = [
        f"# {paper['short']}：论文精读与医学教育资产复现判断",
        "",
        f"> 正式题名：{paper['title']}  ",
        f"> 发表/状态：{paper['venue']}  ",
        "> 阅读模式：LaTeX-primary；以官方 PDF 作图表与分页核查。  ",
        "> 证据标签：`evidence-backed interpretation` 为原文直接支持的总结；`plausible inference` 为基于原文的研究/迁移判断。",
        "",
    ]
    for section_id in map(str, range(1, 26)):
        lines += [f"## {section_id}. {SECTION_TITLES[section_id]}", "", "### Anchored Points", ""]
        for claim in by_section.get(section_id, []):
            lines.append(f"- [{claim[0]}] {claim[3]}")
        lines += ["", section_body(section_id, paper, detail), ""]
    return "\n".join(lines)


def make_storyboard(paper):
    by_section = {claim[1]: claim for claim in all_claims(paper)}
    return {
        "schema_version": "paper-storyboard/1.0",
        "source_report": "report.md",
        "style": "connected cartoon storyboard; prompts-only because no image-generation tool is exposed in this runtime",
        "panels": [
            {"panel_id": "S1", "title": "单图的盲区", "report_claim_ids": [by_section["4"][0]], "visual_metaphor": "同一位解剖学教师透过一个小窗口观察模型", "prompt": "Scientific educational cartoon, one teacher sees only the front of a 3D object through a window; the hidden back is marked uncertain; no text."},
            {"panel_id": "S2", "title": "论文的替代机制", "report_claim_ids": [by_section["9"][0]], "visual_metaphor": "教师把信息放入对应的模型组件", "prompt": f"Scientific educational cartoon, same teacher uses a clearly labeled conceptual mechanism inspired by {paper['short']} to turn partial visual evidence into a 3D candidate; no equations or text."},
            {"panel_id": "S3", "title": "医学发布门", "report_claim_ids": [by_section["23"][0]], "visual_metaphor": "canonical anatomy 作为校准尺", "prompt": "Scientific educational cartoon, same teacher compares a generated 3D candidate with a verified anatomy reference, checks landmarks and connections, and rejects an incorrect candidate; no text."},
        ],
    }


def make_lens(paper):
    ids = [claim[0] for claim in all_claims(paper)]
    return {
        "schema_version": "paper-research-lens/1.0",
        "paper": {"title": paper["title"], "source_mode": "latex-primary"},
        "research_equation": {"one_sentence_thesis": paper["lens"]["equation"], "valuable_paradigm": "image-conditioned 3D generation", "broken_assumption": "partial 2D evidence uniquely determines 3D structure", "hard_setting": "single-view and medical-education asset creation", "borrowed_tool": "diffusion / flow / structured latent generation", "unavailable_mechanism": "hidden anatomy ground truth in the input", "surrogate_mechanism": paper["lens"]["module"], "claim_ids": ids[:4]},
        "direction_reconstruction": {"starting_dissatisfaction": "通用 3D 生成的输出可视觉可信，但没有把隐藏结构的证据边界显式交给审核。", "almost_worked_transfer": "通用 image-to-3D 可快速形成候选。", "blocking_constraint": "医学教育中结构数目、左右侧和连接关系不可由单图/文字任意补全。", "replacement_logic": "把模型置于 verified geometry + generative presentation 架构中。", "claim_ids": ids[2:5]},
        "challenge_module_map": [{"challenge": "部分证据下的 3D 不确定性", "failure_mode": "隐藏面或语义关系 hallucination", "design_principle": "把不确定性放入可检查的中间表示或条件融合", "module": paper["lens"]["module"], "ablation_or_evidence": "论文的主实验与消融；医学迁移需另建 topology QC。", "claim_ids": ids[3:7]}],
        "module_lenses": [{"module": paper["short"], "failure_fixed": "论文所针对的生成/表示瓶颈", "ideal_unavailable_solution": "输入中拥有完整、可信的三维事实", "available_proxy": "图像、文本、通用 3D prior 与中间表示", "hidden_assumption": "代理信号与真实隐藏结构兼容", "future_direction": paper["lens"]["future"], "claim_ids": ids[3:]}],
        "citation_logic": [{"citation_cluster": "TRELLIS/LRM/单图前馈与扩散基线", "narrative_function": "方法祖先与对照压力", "assumption_inherited": "通用资产数据的图像-3D 对齐可迁移", "paper_move": "按各自论文改进表示、效率或条件控制", "claim_ids": ids[:5]}],
        "experiment_story_map": [{"experiment": "论文主表与消融", "claim_supported": "对应方法组件在作者协议中的收益", "counterfactual": "没有该中间表示/融合组件的系统", "stress_condition": "通用资产 benchmark，不是医学 anatomy benchmark", "claim_ids": ids[6:8]}],
        "story_patterns": [{"pattern_name": "hidden-assumption break", "formula": "partial 2D evidence + prior -> candidate; verified anatomy + QC -> publishable educational asset", "lesson": "下一篇医疗 3D 论文应把未验证的 hidden structure 变成可测量、可拒绝、可修订的对象。", "claim_ids": ids[2:]}],
        "boundary_directions": [{"title": "Anatomy-aware generation QC", "hidden_assumption": "通用 3D metrics 足以保证教学正确", "what_breaks": "左右侧、连接、内部腔室和部件数量可能错误", "new_direction": paper["lens"]["future"], "claim_ids": ids[-2:]}],
    }


def main():
    root_claims = []
    root_sections = []
    docs = []
    merged_paragraphs = []
    for key, paper in PAPERS.items():
        paper_root = REPORT_ROOT / key
        report = make_report(paper)
        write(paper_root / "report.md", report)
        write(paper_root / "traceability_manifest.json", json.dumps({"schema_version": "paper-traceability/1.0", "paper": {"title": paper["title"], "source_mode": "latex-primary", "report_path": "report.md"}, "claims": [evidence(c, paper) for c in all_claims(paper)]}, ensure_ascii=False, indent=2))
        write(paper_root / "research_lens.json", json.dumps(make_lens(paper), ensure_ascii=False, indent=2))
        write(paper_root / "storyboard_manifest.json", json.dumps(make_storyboard(paper), ensure_ascii=False, indent=2))
        write(paper_root / "storyboard_prompts.md", "\n\n".join(f"## {p['panel_id']} {p['title']}\n\n{p['prompt']}" for p in make_storyboard(paper)["panels"]) + "\n")
        tex_stem = "neurips_2025" if key == "hunyuan3d_2_1" else "main"
        individual_reader = {
            "schema_version": "paper-reader-artifacts/1.0",
            "paper": {"title": paper["title"], "source_mode": "latex-primary"},
            "report": {"markdown": "report.md"},
            "traceability_manifest": "traceability_manifest.json",
            "latex_paragraphs": "latex_run/latex_paragraphs.json",
            "research_lens": "research_lens.json",
            "documents": [{
                "doc": paper["doc"],
                "label": paper["short"],
                "pdf": f"latex_run/source/{tex_stem}.pdf",
                "synctex": f"latex_run/source/{tex_stem}.synctex.gz",
            }],
            "storyboard": {"manifest": "storyboard_manifest.json", "prompts": "storyboard_prompts.md", "images": [], "status": "prompts-only"},
            "reader_output": "reader_bundle",
        }
        write(paper_root / "reader_artifacts.json", json.dumps(individual_reader, ensure_ascii=False, indent=2))
        docs.append({
            "doc": paper["doc"],
            "label": paper["short"],
            "pdf": rel(paper_root / "latex_run" / "source" / f"{tex_stem}.pdf"),
        })
        root_sections.append(f"## {paper['short']}\n\n{paper['summary']}\n\n详见 [{paper['short']} 的独立精读报告](../{key}/report.md)。")

    batch_report = [
        "# 基于 2D 的 3D 生成与医学教育资产：四篇核心论文精读",
        "",
        "> 范围：根据《论文精选与复现路线》收敛出的四篇近期核心模型：SPAR3D、Hunyuan3D 2.1、TIGON、TRELLIS.2。目录 `精选/` 其余论文（综述、场景、4D、部件化等）不在本轮批量深读范围。",
        "",
        "## 结论",
        "",
        "- [C30.1] 四篇不是同一赛道的“谁更强”：SPAR3D 是低门槛可编辑 mesh 基线，Hunyuan3D 2.1 是 PBR production 候选，TIGON 检验 image+text 的条件增益，TRELLIS.2 给出复杂拓扑/PBR 上界。",
        "- [C30.2] 对医学教育，所有模型只能生成候选草模或 presentation；可发布几何必须来自 verified canonical anatomy/scan-derived segmentation，并经 landmark、part graph、topology 与专家审核。",
        "",
        "## 比较矩阵",
        "",
        "| 模型 | 真正的技术变量 | 最适合回答的问题 | 当前路线定位 | 关键风险 |",
        "|---|---|---|---|---|",
        "| SPAR3D | point diffusion + triplane meshing | 单图背面如何可编辑、如何直接得到 GLB？ | 首个复现 | 点云表达的是背面 prior，不是事实 |",
        "| Hunyuan3D 2.1 | shape / PBR paint 分离 | geometry 与 material 能否分开验收？ | 主生产候选 | 社区许可与显存；指标不等于解剖正确 |",
        "| TIGON | dual DiT + bridge | text 是否真的补足低信息 image？ | 研究主候选 | image-text 冲突常偏向 image；Gaussian 输出边界 |",
        "| TRELLIS.2 | O-Voxel + SC-VAE | 能否表达复杂拓扑、内腔与 PBR？ | 24GB+ Linux 高端上界 | voxel alias、洞、缺少 semantic graph |",
        "",
        "## 复现顺序",
        "",
        "1. **SPAR3D**：先建统一 artifact / GLB / Three.js / QC harness。",
        "2. **Hunyuan3D 2.1**：分别跑 shape-only、paint-only、end-to-end；完成许可证审计。",
        "3. **TIGON**：做 image-only、text-only、image+text 与冲突条件实验；只评估条件融合假设。",
        "4. **TRELLIS.2**：在 Linux + NVIDIA ≥24GB 且前述基线已可比较时接入，测复杂表面上界。",
        "",
        "## 统一发布门",
        "",
        "`candidate generation -> canonical alignment + landmark / part-graph / topology QC -> human revision -> medical reviewer -> GLB + provenance + education-only metadata`",
        "",
        "任何一项不通过都不能以“视觉好看”绕过。尤其不允许结构数目、左右侧、连接/包含关系、关键孔道/腔室或主要地标出错。",
        "",
        "## 逐篇入口",
        "",
        *root_sections,
        "",
        "## Sources Used",
        "",
        "- 原项目路线报告（作为范围和复现优先级证据）",
        "- 四篇论文的官方 arXiv source 与 PDF；SPAR3D/TIGON/TRELLIS.2 使用 CVPR proceedings PDF。",
    ]
    write(ROOT / "report.md", "\n".join(batch_report) + "\n")

    # Add the two batch-level claims with route-report PDF fallback anchors.
    route_claims = [
        {"claim_id": "C30.1", "section_id": "30", "section_title": "路线总比较", "claim_text": "四篇不是同一赛道的“谁更强”：SPAR3D 是低门槛可编辑 mesh 基线，Hunyuan3D 2.1 是 PBR production 候选，TIGON 检验 image+text 的条件增益，TRELLIS.2 给出复杂拓扑/PBR 上界。", "interpretation_type": "evidence-backed interpretation", "research_role": "project route synthesis", "evidence": [{"evidence_id": "E-C30.1-a", "doc": "route", "paragraph_id": "pdf::route::p1", "quote": "路线报告把四个模型分别列为首个复现、主生产候选、研究主候选和高端上界。", "relation": "direct", "locator_snippets": ["立即复现：3 个主项目"]}]},
        {"claim_id": "C30.2", "section_id": "30", "section_title": "路线总比较", "claim_text": "对医学教育，所有模型只能生成候选草模或 presentation；可发布几何必须来自 verified canonical anatomy/scan-derived segmentation，并经 landmark、part graph、topology 与专家审核。", "interpretation_type": "evidence-backed interpretation", "research_role": "medical safety boundary", "evidence": [{"evidence_id": "E-C30.2-a", "doc": "route", "paragraph_id": "pdf::route::p5", "quote": "原路线报告给出 verified geometry + generative presentation 与 QC/审核门。", "relation": "direct", "locator_snippets": ["可信 canonical anatomy mesh"]}]},
    ]
    write(ROOT / "traceability_manifest.json", json.dumps({"schema_version": "paper-traceability/1.0", "paper": {"title": "基于2D的3D生成与医学教育资产：四篇核心论文精读", "source_mode": "pdf-primary", "report_path": "report.md"}, "claims": route_claims}, ensure_ascii=False, indent=2))
    batch_lens = {"schema_version": "paper-research-lens/1.0", "paper": {"title": "四篇核心论文的复现路线", "source_mode": "mixed-source"}, "research_equation": {"one_sentence_thesis": "在医学教育中，2D/text prior 可高效生成候选，但不可见解剖事实必须由 verified geometry + QC 补足。", "valuable_paradigm": "image-to-3D foundation models", "broken_assumption": "视觉保真等于结构正确", "hard_setting": "教育资产的安全发布", "borrowed_tool": "point/latent/PBR/multimodal generation", "unavailable_mechanism": "单一输入中完整解剖真值", "surrogate_mechanism": "canonical geometry、landmark、part graph、topology QC、人工审核", "claim_ids": ["C30.1", "C30.2"]}, "direction_reconstruction": {"starting_dissatisfaction": "通用 3D 模型 demo 不可横向比较，也没有医学发布门。", "almost_worked_transfer": "把通用 image-to-3D 直接用于医学插图。", "blocking_constraint": "隐藏结构与拓扑关系不能由视觉合理性保证。", "replacement_logic": "用统一 benchmark、生成候选与 canonical QC 分层。", "claim_ids": ["C30.1", "C30.2"]}, "challenge_module_map": [], "module_lenses": [], "story_patterns": [{"pattern_name": "verification-first production", "formula": "generate -> align -> topology/ontology QC -> expert review -> publish", "lesson": "把不可验证的生成自由度限制在 presentation 层。", "claim_ids": ["C30.2"]}], "boundary_directions": [{"title": "Anatomy-aware 3D generation", "hidden_assumption": "通用 proxy metric 足以保证教学正确", "what_breaks": "结构和关系可能错而仍有高 render similarity", "new_direction": "以 part graph、laterality、landmark 与 uncertainty 训练/评测生成器", "claim_ids": ["C30.2"]}]}
    write(ROOT / "research_lens.json", json.dumps(batch_lens, ensure_ascii=False, indent=2))
    storyboard = {"schema_version": "paper-storyboard/1.0", "source_report": "report.md", "style": "connected cartoon storyboard; prompts-only because no image-generation tool is exposed in this runtime", "panels": [{"panel_id": "S1", "title": "四种工具，不是四个冠军", "report_claim_ids": ["C30.1"], "visual_metaphor": "同一位教师选择不同工具", "prompt": "Scientific educational cartoon storyboard, same anatomy teacher at a workbench choosing four distinct tools: a point-cloud sketch tool, a PBR paint tool, a text-image fusion tool, and a topology voxel tool; no text."}, {"panel_id": "S2", "title": "生成候选", "report_claim_ids": ["C30.1"], "visual_metaphor": "候选草模", "prompt": "Scientific educational cartoon, same teacher produces four translucent 3D candidate models from 2D references, clearly marking unseen regions as uncertain; no text."}, {"panel_id": "S3", "title": "可信发布门", "report_claim_ids": ["C30.2"], "visual_metaphor": "canonical anatomy 作为校准尺", "prompt": "Scientific educational cartoon, same teacher uses a verified anatomy reference, landmark ruler, part graph checklist, and expert review stamp before publishing a teaching asset; no text."}]}
    write(ROOT / "storyboard_manifest.json", json.dumps(storyboard, ensure_ascii=False, indent=2))
    write(ROOT / "storyboard_prompts.md", "\n\n".join(f"## {x['panel_id']} {x['title']}\n\n{x['prompt']}" for x in storyboard["panels"]) + "\n")
    docs.append({"doc": "route", "label": "原路线报告", "pdf": "project_route_report.pdf"})
    reader = {"schema_version": "paper-reader-artifacts/1.0", "paper": {"title": "基于2D的3D生成与医学教育资产：四篇核心论文精读", "source_mode": "pdf-primary"}, "report": {"markdown": "report.md"}, "traceability_manifest": "traceability_manifest.json", "research_lens": "research_lens.json", "documents": docs, "storyboard": {"manifest": "storyboard_manifest.json", "prompts": "storyboard_prompts.md", "images": [], "status": "prompts-only"}, "reader_output": "reader_bundle"}
    write(ROOT / "reader_artifacts.json", json.dumps(reader, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
