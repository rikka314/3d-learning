# Reproduction results

验证日期：2026-08-25。

## 自动验证

- `npm ci`：成功，按 `showcase/package-lock.json` 安装 20 个 package。
- `npm run build`：成功，TypeScript `--noEmit` 与 Vite production build 均通过。
- Python suite：`1112` tests，结果 `OK`；`4` 项因上游未发布的历史截图或 rig gate 脚本跳过。

日志：

- `logs/showcase-build.txt`
- `logs/unittest-v1.5.1.txt`

## 浏览器验证

- 地址：`http://127.0.0.1:4173/#/x/crown-chest`
- 页面标题：`img2threejs — Live Demo Gallery`
- 展品：`Crowned Loot Chest`
- 控制台：0 errors，0 warnings
- 截图：[crown-chest-showcase.png](screenshots/crown-chest-showcase.png)

## 结论

固定版本在本机能够完成安装、测试、生产构建与 WebGL 展示。该结果证明 img2threejs 的官方程序化 Three.js 路线可复现；它不等价于对一张新图进行零人工、端到端生成。

