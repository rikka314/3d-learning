# Source locks

检出日期：2026-08-25。

| 组件 | 上游 | 固定版本 | 本地目录 |
| --- | --- | --- | --- |
| img2threejs | https://github.com/img2threejs/img2threejs | tag `v1.5.1`, commit `dede5909be4e494b228c801a55dda47439143932` | `upstream/` |
| img2threejs showcase | https://github.com/img2threejs/img2threejs-showcase | commit `a62ba87487e97a0c8cca90063bc0e85487e8894f` | `showcase/` |

两个目录都移除了嵌套 `.git`，由父级 `3d-learning` 仓库统一追踪。`upstream/` 以该固定提交为基线，另含 Windows 测试启动兼容补丁和本地 `ReferenceSet v1` 多视图工作流扩展，详见 `LOCAL_PATCHES.md`。Three.js generator、showcase 模型与前端运行时仍保持锁定版本内容。
