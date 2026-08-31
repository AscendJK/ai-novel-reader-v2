AI Novel Reader - 后端包部署说明
=================================

本包为精简后端包（不含 node_modules，首次启动自动安装依赖）。
后端用于提供小说数据同步、RAG 问答与 TTS 朗读服务。

一、环境要求
-----------
- Node.js 18-22 LTS（必须；23+ 有破坏性变更，better-sqlite3 无预编译二进制）
- Python 3.9+（可选，仅"服务端推理"朗读引擎需要）
  - 安装后运行: pip install sherpa-onnx
  - 不安装也不影响其他功能（浏览器推理 / Web Speech 朗读正常）

二、启动
-------
Windows:  双击 start.bat   （或管理员 cmd 运行）
macOS/Linux: sh start.sh    （赋予执行权限: chmod +x start.sh）

首次启动会自动 npm install（需联网）。启动成功后:
- 后端地址: http://localhost:5173
- 管理后台: http://localhost:5173/admin
- 前端页面: https://ascendjk.github.io/ai-novel-reader-v2/

停止:  Windows: 双击 stop.bat
      macOS/Linux: sh stop.sh
启动/停止脚本会自动清理服务进程（node 后端 + python 推理进程），
如遇端口占用或进程残留，先运行停止脚本再启动即可。

三、TTS 朗读引擎（设置页切换）
------------------------------
| 模式         | 推理位置          | 依赖                          |
|--------------|-------------------|-------------------------------|
| 服务端推理   | 服务器 Python     | Python + pip install sherpa-onnx |
| 浏览器推理   | 浏览器 WASM(离线) | 浏览器下载模型（约 380MB）一次   |
| Web Speech   | 浏览器内置        | 免下载                        |

- 模型按需下载（约 350MB）：在设置页选择推理模式后点「启用」才下载，
  服务端推理下载到服务器 data/tts-cache（一次，多用户共享），
  浏览器推理下载到浏览器 IndexedDB（每设备一次）。
- 注意：不要使用 int8 模型（会生成全 NaN 无声），必须用 fp32。

四、数据
-------
- server/data/ 目录保存数据库（novels.db）与模型缓存，删除即重置数据。
- 同步/备份功能请在管理后台配置。

五、常见问题
-----------
- 端口被占用: 5173 被其他程序占用时启动失败，关闭占用程序后重试。
- npm install 失败: 确认 Node 为 18-22 LTS；网络受限可换国内 npm 镜像。
- 服务端推理不可用: 确认已安装 Python 并 pip install sherpa-onnx。
