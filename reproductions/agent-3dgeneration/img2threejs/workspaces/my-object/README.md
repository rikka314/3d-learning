# Mitochondrion Cutaway — Three.js Procedural Model

基于单张参考图生成的可运行 Three.js 程序化线粒体剖面模型。模型包含有机外膜、浅层基质、开放式切缘、连续内膜、五条交替嵴折、底部回环、基质颗粒、细小散点与外膜孔隙。

## 运行

```powershell
npm install
npm run dev
```

浏览器打开 Vite 输出的本地地址。生产构建：

```powershell
npm run build
```

## 交互

- 拖拽旋转，滚轮缩放。
- 单击部件可显示名称并高亮。
- “爆炸视图”分离基质、内膜网络与切缘。
- “转台”启用自动旋转。
- 查询参数支持固定复核视角：`?capture=1&view=front|threeQuarter|right|rear|left|top|close`。
- 灯光复核：`&light=neutral|grazing`；无贴图 clay 复核：`&clay=1`。

## 主要文件

- `src/createObjectModel.ts`：程序化几何、PBR 材质、运行时节点/socket/collider。
- `src/main.ts`：Three.js 场景、相机、交互、截图视角、运行时清单与性能读数。
- `object-sculpt-spec.json`：完整 sculpt spec 与逐 pass 复核历史。
- `image-analysis.md`：参考图分析。
- `output/final-front.png`、`output/final-three-quarter.png`：最终浏览器截图。
- `output/final-visual-review.json`：最终视觉与门禁结论。

## 边界

这是针对低分辨率单视图参考的风格化教学模型。背面、厚度和隐蔽连接均为有约束的推断；切面采用浅层程序化构造，不应作为生物医学定量、解剖测量或制造级资产使用。
