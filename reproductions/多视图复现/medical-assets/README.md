# 医学原始资料

这里保存三套模型共用的、不可变的医学原始资料。二进制资料不进入 Git；每份资料必须在相邻的 `provenance.json` 中记录来源、版本、许可证、文件大小和 SHA-256。

当前顺序：

1. `z-anatomy/`：标准化教学器官几何，先提取心脏作为 `organ-heart-001`。
2. `allen-cell/`：单细胞核与 TOM20 线粒体 OME-TIFF；只下载选定的单细胞，不拉取数十 GB 的整批训练集。

原始资料不直接喂给多视图模型。需先根据 [`../MEDICAL_BENCHMARK.md`](../MEDICAL_BENCHMARK.md) 生成固定相机、固定画布的输入渲染和真值渲染，再复制到各项目的 `inputs/medical/`。
