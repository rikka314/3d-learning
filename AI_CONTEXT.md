# AI 快速上下文

> 最近更新：2026-08-25
> 用途：项目级路由文档。先读本文件，再进入具体资料、笔记或复现项目。

## 项目一句话

面向 3D AI 的长期学习与研究工作区，集中管理文献资料、个人思考和项目复现。

## 关键运行事实

- **项目名称**：3d-learning
- **技术栈**：Docs-first（Markdown）；具体复现项目技术栈独立决定
- **项目路径**：`D:\Learn\20_Projects\3dresearch\3d-learning`
- **GitHub 仓库**：`https://github.com/rikka314/3d-learning`（private）
- **项目性质**：研究资料库，不是单一应用程序

## 仓库地图

- `literature/` — 外部资料及阅读索引
  - `literature/papers/` — 论文、技术报告及补充材料
  - `literature/report/` — 多文献专题调研、综述及其下载清单
  - `literature/courses/` — 课程、讲义和学习路线
  - `literature/tools/` — 工具、平台及相关使用资料
- `thoughts/` — 个人思考、问题、方向判断与阶段性总结
- `reproductions/` — 项目复现容器；一个复现项目对应一个独立子目录
- `.codex/skills/` — 项目级 Codex skill；包含研究检索和论文阅读两组能力
  - `research-ops`、`exa-search`、`deep-research` — 研究检索与多来源调研
  - `read-paper` — 面向初学者的中文论文精读与学习报告
  - `paper-reading` — 论文论证、实验、公式与可复现性的严格分析
  - `paper-reading-card` — Robotics / AI 单篇论文阅读卡片
  - `agent-paper-grounded-reading` — 带证据追踪和研究方向挖掘的深度阅读
- `README.md` — 项目入口和基本使用约定

## 当前 durable facts

- 文献资料、个人思考、项目复现三类内容分开管理。
- 文献资料按 `papers/`、`report/`、`courses/`、`tools/` 四类存放。
- `reproductions/` 只提供容器，不提前创建具体复现项目。
- 各复现项目应自行维护来源、环境、运行方式和结果说明。
- 当前没有统一编程语言、包管理器或运行命令。
- 最新研究进展调研优先从项目级 `research-ops` 进入，按需调用 `exa-search` 或升级到 `deep-research`。
- 论文阅读技能安装在项目级 `.codex/skills/`，不写入用户全局技能目录。
- 当前近期研究主线收敛为两条：`image → 3D` 与 `image + text → 3D`；都属于基于 2D 的单资产生成。
- 医学 3D 的近期产品目标是教育展示而非临床严谨资料；默认采用 `verified geometry + generative presentation`，允许视觉与网格简化，但不允许结构数目、左右侧、连接关系和关键地标错误。
- coding agent 直接生成 Three.js / parametric 3D 资产是长期、低优先级和不确定性较高的观察方向，不挤占当前 image-based 3D 复现资源。
- 当前决策型阅读与复现路线见 `literature/report/基于2D的3D生成与医学教育资产_论文精选与复现路线_2026.md`。

## 默认阅读路线

| 任务类型 | 先读 |
|---|---|
| 查找或新增文献资料 | `literature/README.md` |
| 面向初学者精读单篇论文 | `$read-paper` |
| 严格核查论文论证、公式和实验 | `$paper-reading` |
| 快速生成 Robotics / AI 论文卡片 | `$paper-reading-card` |
| 做证据溯源和研究方向挖掘 | `$agent-paper-grounded-reading` |
| 整理个人想法 | `thoughts/README.md` |
| 新建或继续项目复现 | `reproductions/README.md`，再读对应项目目录 |

## 协作约定

- 默认使用中文撰写说明；论文标题、技术名词、代码和命令保留原文。
- 新内容优先放入已有三类目录，不随意增加平行顶层目录。
- AI 不主动移动、重命名或删除已有资料。
- 如目录结构或长期约定发生变化，同步更新本文件和根目录 `README.md`。
