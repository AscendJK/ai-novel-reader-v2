# 模型文件目录 / Model Files Directory

## 目录结构 / Directory Structure

```
models/
├── builtin/                              # 内置模型（随项目分发，已提交 Git）
│   └── Xenova/
│       ├── bge-small-zh-v1.5/            # BGE Small ZH v1.5 (~26MB)
│       │   ├── config.json
│       │   ├── tokenizer.json
│       │   └── onnx/
│       │       └── model_quantized.onnx
│       └── gte-small/                    # GTE Small (~34MB)
│           ├── config.json
│           ├── tokenizer.json
│           └── onnx/
│               └── model_quantized.onnx
│
└── custom/                               # 自定义模型（用户自行添加，不提交 Git）
    └── Xenova/
        ├── all-MiniLM-L6-v2/             # All-MiniLM-L6-v2 (~23MB)
        │   ├── .gitkeep
        │   └── onnx/                     # 用户需下载模型文件到此目录
        ├── multilingual-e5-small/        # Multilingual E5 Small (~120MB)
        │   ├── .gitkeep
        │   └── onnx/
        ├── paraphrase-multilingual-MiniLM-L12-v2/  # MiniLM L12 (~120MB)
        │   ├── .gitkeep
        │   └── onnx/
        └── .gitkeep                      # 目录说明文档
```

## 内置模型 / Built-in Models

以下模型随项目分发，无需额外下载：

| 模型 | 大小 | 适用场景 | 引擎 ID |
|------|------|---------|---------|
| BGE Small ZH v1.5 | ~26MB | 中文最佳 / Best for Chinese | `bge-small-zh` |
| GTE Small | ~34MB | 中英文均衡 / Balanced CN/EN | `gte-small` |

## 自定义模型 / Custom Models

支持所有 Transformers.js 兼容的 ONNX 嵌入模型：

| 模型 | 大小 | 适用场景 | 引擎 ID |
|------|------|---------|---------|
| All-MiniLM-L6-v2 | ~23MB | 英文最佳 / Best for English | `Xenova/all-MiniLM-L6-v2` |
| Multilingual E5 Small | ~120MB | 多语言 / Multi-language | `Xenova/multilingual-e5-small` |
| MiniLM L12 v2 | ~120MB | 50+语言深度理解 / Deep multilingual | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` |

### 下载地址 / Download Links

推荐从 Hugging Face 下载 Xenova 量化版模型（已包含 INT8 量化的 ONNX 文件）：

- [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2)
- [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small)
- [Xenova/paraphrase-multilingual-MiniLM-L12-v2](https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2)

### 安装步骤 / Installation Steps

1. 从 Hugging Face 下载模型文件（需要 4 个文件）：
   - `config.json`
   - `tokenizer.json`
   - `tokenizer_config.json`
   - `onnx/model_quantized.onnx`

2. 创建以模型名命名的文件夹（如 `all-MiniLM-L6-v2`）

3. 将下载的文件放入文件夹：
   ```
   public/models/custom/Xenova/all-MiniLM-L6-v2/
   ├── config.json
   ├── tokenizer.json
   ├── tokenizer_config.json
   └── onnx/
       └── model_quantized.onnx
   ```

4. 重启 dev server

5. 打开设置页 → 本地检索引擎 → 点击"扫描"检测自定义模型

6. 选择模型后，下次打开小说即可生效

## 注意事项 / Notes

- 模型文件较大（23-120 MB），不适合上传到 GitHub
- 每个模型需要约 100-500 MB 内存加载
- 首次使用时需要下载模型文件到浏览器缓存
- 模型名称支持前缀匹配（如 `deepseek-chat-0324` 自动匹配 `deepseek-chat` 的 Token 预算）
