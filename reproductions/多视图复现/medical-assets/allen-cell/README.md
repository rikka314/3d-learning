# Allen Cell 单细胞源

- 官方下载说明：<https://www.allencell.org/data-downloading.html>
- 官方可下载示例：collection `cellviewer-1-4`，file ID `C70935`
- 下载 API：<https://files.allencell.org/api/2.0/file/download?collection=cellviewer-1-4&id=C70935>

`C70935/download.tar.gz.part` 是可续传的临时文件，不是有效完成资产。官方服务器本次传输速度过低，为避免阻塞三套模型环境下载而暂停；恢复时使用同一 URL 和 `curl --continue-at -`，完成后再校验、解包并读取 OME 元数据。确认通道所对应的细胞器之前，不把它登记为 `cell-nucleus-001` 或 `cell-mito-001`。
