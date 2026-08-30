# Storyboard Prompts: Shap-MeD

共同视觉设定：连贯的五幕科学教育漫画；主角是一台友善的蓝色研究机器人，场景统一为明亮的白色 3D 医学研究工作室，关键解剖结构以红色半透明蓝图呈现；横向构图、干净轮廓、轻微水彩质感、无品牌标志、无水印、尽量无可读文字。故事板只把报告中已核验的机制、证据与研究方向转成教学隐喻，不作为论文事实证据。

## S1 — 通用雕塑家遇到医学几何

Use case: illustration-story  
Asset type: connected paper-reading storyboard panel 1 of 5  
Primary request: The recurring blue research robot is a capable generic 3D sculptor producing ordinary objects from text, then confronts a glowing red anatomical blueprint of a liver, kidney, heart, and aorta whose geometry demands domain-specific knowledge.  
Composition/framing: landscape studio scene, generic sculptures on the left, four anatomical blueprints on the right, robot centered at the transition.  
Constraints: no readable text; no logos; no watermark; show a domain gap rather than a broken model.

Linked claims: `C2.1`, `C4.1`.

## S2 — 医学网格先过数据审计

Use case: illustration-story  
Asset type: connected paper-reading storyboard panel 2 of 5  
Primary request: The same blue robot inspects four bins of medical meshes for aorta, liver, kidney, and heart; one wrongly sorted brain mesh is moved aside, a heart mesh with visible holes is flagged, and the much smaller heart bin makes class imbalance visually obvious.  
Composition/framing: landscape quality-control bench with magnifying tools and four unequal mesh collections.  
Constraints: no readable text or invented counts; no logos; no watermark; make misclassification, holes, and imbalance distinct.

Linked claims: `C8.4`, `C15.1`, `C21.2`.

## S3 — 冻结编码端，只微调生成端

Use case: illustration-story  
Asset type: connected paper-reading storyboard panel 3 of 5  
Primary request: The same robot operates a two-stage machine: a transmitter that converts audited medical meshes into latent crystals is visibly frozen inside clear ice, while a connected diffusion generator is trainable and surrounded by adjustment tools; text prompts enter the trainable side and medical 3D shapes emerge.  
Composition/framing: landscape left-to-right pipeline, frozen transmitter on the left, latent bridge in the middle, fine-tuned diffusion generator on the right.  
Constraints: no readable text; no formulas; no logos; no watermark; the frozen-versus-trainable boundary must be unmistakable.

Linked claims: `C9.1`, `C14.2`.

## S4 — 损失下降，但证据边界仍在

Use case: illustration-story  
Asset type: connected paper-reading storyboard panel 4 of 5  
Primary request: The same robot celebrates a lower latent-error gauge and improved medical-looking shapes, while a transparent evidence barrier still separates that gauge from unanswered anatomy checks represented by calipers, topology inspection, anatomical landmarks, and a clinician's review board.  
Composition/framing: landscape split scene, verified latent improvement on the left and unresolved geometry/clinical validation on the right.  
Constraints: no readable text or invented numbers; no logos; no watermark; portray a real improvement without implying clinical correctness.

Linked claims: `C17.1`, `C17.2`, `C21.1`.

## S5 — 锁定可信几何，再生成表达层

Use case: illustration-story  
Asset type: connected paper-reading storyboard panel 5 of 5  
Primary request: The same blue robot builds a polished medical 3D visualization around a locked golden verified liver scaffold; the immutable inner geometry is checked by calipers and landmarks, while a flexible translucent outer presentation layer adds material, color, lighting, and explanatory context.  
Composition/framing: landscape research-roadmap finale, locked verified core central, controllable generative presentation shell growing around it.  
Constraints: no readable text; no logos; no watermark; clearly distinguish validated geometry from generative appearance.

Linked claims: `C23.2`, `C23.1`.
