# 数据来源与清洗记录

## 1. 样本说明

样本量为 5 篇真实公开论文，均直接下载自 arXiv PDF 页面（下载日期：2026-08-03）。RAG、REALM、DPR 为同主题检索增强/开放域问答论文；Transformer 和 BERT 用于覆盖不同章节命名和版面。

| 文件 | 论文 | 来源 | 页数 | 抽取字符数 | 字节数 | SHA-256 |
|---|---|---|---:|---:|---:|---|
| `rag-2005.11401.pdf` | Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks | https://arxiv.org/abs/2005.11401 | 19 | 69,104 | 885,323 | `23e3249e9a1e75418d82efecab0ea8c4d033b89c93742f63208d47ce01f21233` |
| `realm-2002.08909.pdf` | REALM: Retrieval-Augmented Language Model Pre-Training | https://arxiv.org/abs/2002.08909 | 12 | 49,319 | 419,037 | `0ec1a7ab3de5514c6d3baa8af0322816d4ee7cd4c14b9f2c450cbc9da9e6b363` |
| `dpr-2004.04906.pdf` | Dense Passage Retrieval for Open-Domain Question Answering | https://arxiv.org/abs/2004.04906 | 13 | 55,712 | 383,508 | `3e67fc1a9977715acf722d85f0b7d124b03715e975f6310a4d6c12094190912f` |
| `transformer-1706.03762.pdf` | Attention Is All You Need | https://arxiv.org/abs/1706.03762 | 15 | 39,594 | 2,215,244 | `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697` |
| `bert-1810.04805.pdf` | BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding | https://arxiv.org/abs/1810.04805 | 16 | 63,804 | 775,166 | `5692a5514787a8c6727b4ff3b726a3385798bc68e12138d1d4af83947e2acf6e` |

仓库保存原始 PDF，不保存人工改写文本。表中字符数由当前 `load_pdf` 在同一环境实测，包含页面分隔符，不等同于论文词数。

## 2. 抽取步骤

1. 校验扩展名、PDF magic bytes、文件大小、密码和页数。
2. PyMuPDF 使用 `get_text("text", sort=True)` 抽取；同时从 dict block 记录图片 bbox。
3. 若整篇可见字符少于 80，使用 pdfplumber layout 模式兜底；只采用字符更多的版本。
4. 页面之间插入 form-feed `\f`，建立 `page_offsets`。

本批 5 篇均由 PyMuPDF 成功抽取，不需要 pdfplumber 兜底，也不是扫描件。

## 3. 清洗规则

- 统一 CRLF/CR 为 LF，删除 Unicode soft hyphen。
- 行内多个空格/Tab 归一为单空格，保留换行用于章节和段落判断。
- 仅在上一行以 `-` 结尾且下一行以小写英文字母开始时合并断词。
- 对至少两页的文档，统计每页前两行和后两行；规范化数字后，在至少 50% 页面重复的短行作为页眉/页脚移除。
- 连续三个以上空行归一为两个。
- 不删除 Figure/Table caption、公式或图片块；在 chunk 阶段转成占位符并保留原始 metadata。

## 4. 章节金标准

章节准确率只评估公开正文中可见的核心类别，不评估每个附录小节。人工核对集合：

- RAG：Abstract、Introduction、Methods、Experiments、Results、Related Work、Discussion、References（8 类）。
- Transformer：Abstract、Introduction、Background、Model Architecture、Results、Conclusion、References（7 类）。其中 Background 归一为 `related_work`，Model Architecture 归一为 `methods`。

准确率公式和实测结果记录在 `tests/TEST_RESULTS.md`，pytest 会直接重新解析仓库中的 PDF，不读取预生成文本。

## 5. 可复核方式

```powershell
Get-FileHash -Algorithm SHA256 data\papers\*.pdf
.\.venv\Scripts\python.exe -m pytest tests\test_real_papers.py -q
```

若 arXiv 后续替换 PDF 版本，下载文件的 SHA-256 可能变化；本仓库内文件及上表哈希是本次验收的固定基线。
