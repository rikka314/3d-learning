# Changelog

## 1.1.0 - Agent routing and specification upgrade

### Agent 匹配调用

- 将触发范围收敛为“具体论文或少量明确论文的解读”，减少与文献检索、PDF、GitHub、翻译和 HTML Skill 的误匹配。
- 重写 `description`，同时给出高密度正向触发词和排除场景。
- 明确论文官方 repo 只能作为已识别论文的辅助证据，不能单独触发 Skill。
- 新增 quick screen、standard interpretation、focused deep read、method and reproduction、presentation、direct comparison、HTML extension 七种模式。
- 新增 16 条中英文触发评测用例，覆盖 8 个正例和 8 个反例。

### Agent Skills 规范

- `SKILL.md` 增加 `license`，metadata 全部使用字符串值。
- 保持跨客户端兼容，不使用产品特定的 `compatibility` 或 `allowed-tools` 约束。
- 将 `docs/` 重构为标准的 `references/`，将 HTML 示例移动到 `assets/`。
- 所有主资源引用改为 Skill 根目录相对路径，并将主 `SKILL.md` 控制在 500 行以内。
- 新增零依赖 `scripts/validate_skill.py`，检查 frontmatter、名称、描述、资源引用、上下文规模、评测集和缓存污染。

### 内容与质量

- 新增输入契约、证据优先级、版本差异处理和完成标准。
- 将遥感专项规则从通用质量清单拆出，仅在遥感论文中按需加载。
- 新增指定论文对比输出模板，要求先判断实验口径是否可比。
- 删除未经必要支撑的 KaTeX 性能倍数描述。

### 安全与可运行性

- Bridge 改用常量时间 token 比较。
- 非回环地址启动 Bridge 时强制要求 token。
- 默认 CORS 从通配符收敛为本地 Origin 白名单，并增加请求体大小限制。
- smoke test 增加 Skill 规范、触发评测集、Bridge 非回环保护和 HTML 严格契约验证。

## 1.0.0 - Two-pass reading and experiment-first review

- 建立“快速扫读 → Abstract → 主框架图/Conclusion → Experiment → 阅读决策 → Introduction → Approach → Related Work”的两遍阅读流程。
- 新增 A/B/C/D 阅读优先级、实验公平性、复现风险和遥感专项检查。
- 将 HTML 调整为可选交付层。
