# Paper Reading Skill

面向 Agent 的具体论文解读 Skill。它不把论文逐段翻译一遍，而是先恢复作者的研究逻辑、检查实验能否支撑主张，再决定是否投入方法、公式、补充材料和官方仓库的精读。

## 适用范围

本 Skill 只处理已经明确的一篇论文，或少量明确命名、需要直接比较的论文。论文可以通过 PDF、标题、DOI、arXiv 页面或官方论文页提供。

典型任务包括：

- 快速判断论文讲什么、是否值得精读；
- 梳理作者的核心想法与端到端处理流程；
- 审查实验设置、基线、公平性、消融和复现风险；
- 解释指定 Figure、模块、公式和训练目标；
- 结合论文官方 repo 整理复现清单；
- 整理成组会或教学讲解；
- 修订由本 Skill 生成的 paper-reading HTML。

不适用于泛文献搜索、批量论文收集、URL/DOI 核验、全文翻译、通用学术写作、独立 GitHub review、正式审稿意见或普通网页开发。

## 目录结构

```text
paper-reading/
├── SKILL.md
├── agents/openai.yaml
├── references/
│   ├── reading-workflow.md
│   ├── output-contracts.md
│   ├── evidence-quality.md
│   ├── remote-sensing.md
│   ├── html-contract.md
│   ├── html-layout.md
│   ├── katex.md
│   └── mermaid.md
├── assets/minimal-paper.html
├── scripts/
│   ├── validate_skill.py
│   ├── validate_paper_html.py
│   └── bridge.py
├── evals/evals.json
└── tests/smoke_test.py
```

`SKILL.md` 只保留触发边界、核心决策和资源路由；详细方法、输出模板和 HTML 规范按需加载，减少上下文占用。

## 验证

```bash
python3 scripts/validate_skill.py . --json
python3 tests/smoke_test.py
python3 scripts/validate_paper_html.py assets/minimal-paper.html --contract --strict --json
```

若环境已安装 Agent Skills 官方参考验证器，也可以运行：

```bash
skills-ref validate .
```

## HTML bridge

Bridge 默认只绑定 `127.0.0.1`。绑定非回环地址时必须提供 token；浏览器 Origin 默认只允许 `null`、当前本地端口的 `127.0.0.1` 和 `localhost`。

```bash
python3 scripts/bridge.py \
  --page /absolute/path/to/paper.html \
  --log /absolute/path/to/requests.jsonl \
  --token <local-token>
```

## 版本

当前版本：`1.1.0`。

本项目基于 `Agentchengfeng/paper-reading-skills` 深度改编，协议与来源见 `LICENSE` 和 `NOTICE.md`。
