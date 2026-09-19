# AI 小说精读助手

浏览器端 AI 小说阅读工具。上传 TXT/EPUB，配置任意 LLM API，获得章节总结、人物关系图谱、剧情时间线、AI 问答等深度阅读辅助。自带用户名系统，多设备自动同步阅读进度。

[English](README_EN.md)

## 快速开始

项目采用**前后端分离架构**：前端部署在 GitHub Pages，后端运行在本地电脑。后端支持 HTTP / HTTPS 双端口同时监听（HTTPS 需安装 mkcert，见下文）。

### 前端（GitHub Pages）

前端已部署在 GitHub Pages，**无需安装**，直接访问：

**https://ascendjk.github.io/ai-novel-reader-v2/**

不配置服务器也能使用（离线模式），配置后可同步数据。

### 后端（本地部署）

后端提供 RAG 构建、数据同步、书库管理等服务，运行在你自己的电脑上。

**前置条件**：
- [Node.js](https://nodejs.org) v18~22 LTS（推荐 22）
- [mkcert](https://github.com/FiloSottile/mkcert)（**可选**，用于 HTTPS；iOS 用户强烈推荐，见「HTTPS 与 mkcert」章节）
- Python 3.9+（**可选**，仅"服务端推理"朗读引擎需要：`pip install sherpa-onnx`；不安装不影响其他功能）

> **Node.js 24+ 用户注意**：`better-sqlite3` 在 Node 24 上缺少预编译二进制，需要 Python 3.x 和 C++ 构建工具。建议使用 **Node.js 22 LTS**。

**方式一：下载后端包（推荐）**

从 [Releases](https://github.com/AscendJK/ai-novel-reader-v2/releases) 下载（二选一）：

| 包 | 体积 | 适用 |
|---|---|---|
| `ai-novel-reader-v2-backend.zip` | ~68 KB | **后端包**：配合 GitHub Pages 前端使用 |
| `ai-novel-reader-v2-full.zip` | ~1 MB | **前后端全包**：内含预构建前端，iPhone 同源免证书访问 |

解压后：
- **Windows**：双击 `start.bat`
- **macOS / Linux**：`chmod +x start.sh && ./start.sh`

两个包的启动脚本依次做三件事：调用 `scripts/cleanup-processes.*` 清掉上次残留的 node/python 进程（`stop.*` 也走同一份清理逻辑）→ `npm install`（仅 5 个后端依赖）→ `node server/index.js`；区别是全包的脚本自带 `--full` 参数并伺服 `dist/`（**无需任何构建步骤**）。

> **如何更新后端包**：下载新版 zip，直接解压到旧版目录覆盖即可。
> 后端包不包含 `server/data/` 目录，你的数据库（小说、笔记、阅读进度等）不会丢失。
> 如果之前修改过 `start.bat`（如自定义端口号），覆盖后需重新修改。
> 依赖有变动时脚本会自动执行 `npm install`，无需手动操作。
> 启动脚本会检测 Python + sherpa-onnx（可选依赖），缺失时仅提示、不阻塞启动。

**维护者：如何打包 / 发布后端包**

本地打包（跨平台，PowerShell 7 或 Windows PowerShell 均可）：

```bash
npm run pack:backend                      # 只打后端包
pwsh -File pack-backend.ps1 -IncludeDist  # 额外打前后端全包（需先 npm run build）
```

分别生成到 `release/` 目录：`release/ai-novel-reader-v2-backend.zip`（约 68 KB）和 `release/ai-novel-reader-v2-full.zip`（约 1 MB）。该目录已被 `.gitignore` 忽略。

**自动发布 Release**：推送到 `main` 分支只触发前端部署，不会打包后端。需要发布新版本时打 tag：

```bash
git tag v2.3.0
git push origin v2.3.0
```

GitHub Actions（`.github/workflows/release-backend.yml`）会自动构建前端、分别打包两个 zip、校验产物（检查 `tts-worker.py`、`rag.js`、全包的 `dist/index.html` 等关键文件，缺失即失败）、并创建 Release 上传。也可以在 Actions 页面手动触发（workflow_dispatch）。

**方式二：Clone 整个仓库**

```bash
git clone https://github.com/AscendJK/ai-novel-reader-v2.git
cd ai-novel-reader-v2
```

- **Windows**：双击 `start.bat`
- **macOS / Linux**：`chmod +x start.sh && ./start.sh`

脚本会自动安装依赖、构建前端、启动服务器（完整模式，含前端静态伺服）。

启动后终端会显示地址：
```
[static] serving ...dist at /ai-novel-reader-v2/ (full mode)
[sync] https://0.0.0.0:8443 (full)   <- 已安装 mkcert 时
[sync] http://0.0.0.0:5173 (full)
```

### 连接方式总览（前端 ↔ 后端）

一个后端实例可同时支持以下所有连接方式，按场景选用：

| 方式 | 前端页面来自 | 服务器地址填什么 | iOS Safari | 证书 | SW 离线壳 |
|---|---|---|---|---|---|
| ① Pages + HTTP 后端 | GitHub Pages | `http://IP:5173` | ❌ 平台拦截 | 不需要 | Pages 侧可用 |
| ② Pages + HTTPS 后端（**iOS 推荐**） | GitHub Pages | `https://IP:8443` | ✅ | 需要（mkcert） | Pages 侧可用 |
| ③ 同源 HTTP | 后端伺服 | 不用填（自动同源） | ✅ | 不需要 | 不可用¹ |
| ④ 同源 HTTPS | 后端伺服 | 不用填（自动同源） | ✅ | 需要（mkcert） | 可用 |

¹ 安全上下文限制：局域网 IP 走 HTTP 时浏览器不注册 Service Worker（详见「HTTPS 与 mkcert」）。

- **方式①**：桌面浏览器完全可用（控制台有黄色警告，不影响功能）；仅 iOS 不可用。
- **方式②**：功能最完整——Pages 页面壳常驻公网（关掉电脑也能打开应用），服务器开着时全功能同步。
- **方式③④**：直接访问 `http://IP:5173/ai-novel-reader-v2/`（或 https 8443），页面与 API 同源，**无需配置服务器地址**，自动连接本机后端。

**配置前端连接**（方式①②）：

1. 打开前端页面
2. 在登录界面点击「配置」，输入后端服务器地址
3. 点击「保存并连接」，显示「连接成功」即可

> **智能补全**：地址输入支持简写——`192.168.1.100` 自动补全为 `http://192.168.1.100:5173`；`https://192.168.1.100` 自动补全为 `https://192.168.1.100:8443`。已带端口的地址原样保留。

> **如何查看服务器 IP**：Windows 运行 `ipconfig`，macOS/Linux 运行 `ifconfig` 或 `ip addr`，查找局域网 IPv4 地址。

### 开发模式（可选）

如需本地开发前端，手动分别启动前后端：

```bash
# 终端 1：启动后端
npm run server

# 终端 2：启动前端开发服务器
npm run dev
```

前端开发服务器运行在 `http://localhost:5174`，API 请求自动代理到后端 `localhost:5173`。

---

## iOS / iPadOS 连接指南

iOS 上**所有浏览器**（含 Chrome/Firefox 等第三方，均基于 WebKit 内核）存在两条平台级限制：

1. **混合内容拦截**：HTTPS 页面（GitHub Pages）无法请求 HTTP 后端。与 Chrome/Edge 不同，Safari 无"不安全内容放行"选项，且 `http://127.0.0.1`、`http://localhost` 也不豁免（WebKit Bug 171934，多年未改）。
2. **Service Worker 仅限安全上下文**：HTTP 局域网页面无法注册 SW——意味着离线壳、PWA 缓存在 HTTP 页面上不可用。

因此 iOS 用户有两条可用路径，按是否愿意装一次证书选择：

### 路径 A：同源 HTTP（免证书，最简单）

服务器以完整模式运行后，iPhone Safari 直接访问：

```
http://<电脑IP>:5173/ai-novel-reader-v2/
```

- ✅ 零证书、零安装，打开即用，登录后自动连接本机后端
- ❌ 电脑/服务器关闭时页面不可访问（无 SW 离线壳）
- 首次访问系统可能弹"本地网络"权限，点允许

### 路径 B：mkcert HTTPS（推荐，功能完整）

装一次 mkcert 证书后，获得 `https://<电脑IP>:8443` 受信入口：

- ✅ GitHub Pages 前端正常连接（方式②）
- ✅ 同源 HTTPS（方式④），SW 离线壳可用——服务器关闭后仍能打开应用离线阅读
- 成本：每台 iOS 设备一次性 5 分钟

**电脑端安装 mkcert**（一次性）：

```powershell
# Windows（winget；如提示"已安装"但 mkcert 命令不存在，见下方 FAQ）
winget install FiloSottile.mkcert

# macOS
brew install mkcert

# Linux（Debian/Ubuntu）
sudo apt install mkcert
```

安装后初始化本地 CA（**需要管理员/sudo 权限**，只需一次）：

```powershell
mkcert -install
```

重启后端（`start.bat`），启动日志确认出现 `https://0.0.0.0:8443`。

**证书 IP 变更**：mkcert 证书按生成时机器的 IP 签发。换了 Wi-Fi / IP 变化后，**重启一次后端即可**——启动时会检测当前 IP 是否在证书覆盖范围内，不在就自动按新 IP 重新签发（`rootCA.pem` 与手机端安装不受影响）。仅当日志提示自动重签失败（mkcert 不可用）时，才需手动删除 `server/data/cert.pem` 和 `server/data/key.pem` 再重启。

**根证书与文件位置速查**：

| 文件 | 位置 | 用途 |
|---|---|---|
| `rootCA.pem` | `mkcert -CAROOT` 输出目录（Windows 默认 `%LOCALAPPDATA%\mkcert`） | **发给手机/其他设备安装的**根证书 |
| `rootCA-key.pem` | 同上 | 根证书私钥，**绝对不要外传** |
| `cert.pem` / `key.pem` | `server/data/` | 服务器 HTTPS 证书（后端启动时自动按当前 IP 生成） |
| `rootCA.pem`（副本） | `server/data/`（首次生成证书时自动复制） | 同 CAROOT 的 rootCA，方便取用 |

**mkcert 完整卸载**（不再使用 HTTPS 时）：

```powershell
# 1. 从系统信任存储移除本地 CA（需管理员权限；做了这步手机端证书即失效）
mkcert -uninstall

# 2. 卸载程序本体
winget uninstall FiloSottile.mkcert      # Windows（普通权限即可）
brew uninstall mkcert                    # macOS
sudo apt remove mkcert                   # Linux

# 3. 删除根证书文件（CAROOT 目录，含 rootCA.pem 与 rootCA-key.pem）
mkcert -CAROOT                           # 先查路径，再手动删除整个目录

# 4.（可选）清理项目侧生成的服务器证书与副本
#    删除 server/data/ 下的 cert.pem、key.pem、rootCA.pem
#    之后重启后端会回到纯 HTTP 模式
```

> 卸载后各端影响：电脑端 Windows 信任存储里的 CA 随 `mkcert -uninstall` 移除；**已装证书的 iPhone 需手动删除描述文件**（设置 → 通用 → VPN 与设备管理 → mkcert → 删除描述文件，再到「证书信任设置」确认已消失），否则手机上仍显示已信任但服务器已无法出 HTTPS。

**iPhone 安装根证书**（每台设备一次性。整个流程分**两个必做阶段**：① 安装描述文件 → ② 开启完全信任。iOS 装完①会显示"已安装"，看似结束，但此时证书**仍未受信**——漏掉②是 HTTPS 连不上的最常见原因）：

1. 找到根证书 `rootCA.pem` 并传到 iPhone（隔空投送不可用于证书，用微信/QQ/邮件均可，**传完建议删除文件与聊天记录**——根证书是敏感物）。

   **rootCA.pem 的位置**：mkcert 生成的服务器证书（cert.pem/key.pem）在 `server/data/`，但**根证书固定存在 mkcert 的 CAROOT 目录**，不随项目走：

   ```powershell
   mkcert -CAROOT    # 输出根证书所在目录，Windows 默认: %LOCALAPPDATA%\mkcert
   ```

   打开该目录取 `rootCA.pem`。服务器首次生成证书时也会把根证书复制一份到 `server/data/rootCA.pem`（存在即可直接用）；两种来源等价。
2. **阶段①：安装描述文件**。iPhone 上点开该文件 → 设置自动跳转「已下载描述文件」→ 设置 → 通用 → VPN 与设备管理 → 安装。
   ⚠️ 系统显示"已安装"只是阶段①完成，**此刻还不算装好**，紧接着做阶段②。
3. **阶段②：开启完全信任**。设置 → 通用 → 关于本机 → **证书信任设置** → 把 mkcert 相关项的开关打开。
   ⚠️ **关键步骤，漏掉等于白装**：这是 iOS 设计的独立步骤，藏在「关于本机」深处，安装流程不会引导你来。不开这个开关，Safari 直接访问后端地址会弹证书警告，而应用内（登录页配置服务器地址）的请求则**不弹任何提示、直接静默失败**——正是"装了证书还是连不上"的元凶。

**验证**：Safari 访问 GitHub Pages 前端 → 配置服务器地址 `https://<电脑IP>:8443` → 显示"连接成功"且无证书警告；或直接访问 `https://<电脑IP>:8443/ai-novel-reader-v2/`（同源 HTTPS）。

### 数据线连接（无 Wi-Fi 场景的备用方案）

iPhone 用数据线连电脑后，开启 **个人热点**（设置 → 个人热点 → 允许其他人加入），Windows 会识别出 USB 网络共享，手机与电脑处于 `172.20.10.x` 网段——手机 Safari 访问 `http://172.20.10.2:5173/ai-novel-reader-v2/` 即走数据线（不经路由器、不耗蜂窝流量）。

注意事项：
- Windows 防火墙可能将 USB 网卡识别为"公用网络"，需放行 Node.js 的公用网络入站
- 走 HTTPS（8443）时需先插线重启后端，让证书把 `172.20.10.2` 签进去
- iOS 不支持反向共享（电脑网 → 手机），无需尝试
- 该方案不改变浏览器安全规则：SW、混合内容限制与 Wi-Fi 场景完全一致

> **为什么没有纯 HTTP 的离线方案？** Service Worker 是离线能力的载体，而浏览器规定 SW 只能在安全上下文（HTTPS / localhost）注册，HTTP 局域网页面无法绕过。因此"不装证书"与"SW 离线壳"二选一，装 mkcert 是同时拿到两者的唯一途径。

---

## 多人共用前端

前端部署在 GitHub Pages，所有人共用同一个前端地址。每个人在自己的电脑上运行后端，数据完全隔离：

- 后端各自独立 → 数据库隔离
- 浏览器 IndexedDB 各自独立 → 本地数据互不干扰
- 服务器地址存在各自的 localStorage → 各连各的后端

即使多人使用相同的用户名也无冲突，因为各自连的是各自的后端。

> 如果想完全独立（包括前端），可以 fork 本仓库，部署到自己的 GitHub Pages。

---

## 注意事项

### 服务器重启

服务器使用内存存储会话数据（token、在线状态），**重启后所有会话失效**：

- 已登录的设备会自动检测并重新注册，恢复在线状态，并弹出提示通知
- 同一用户名在多设备使用时，先重新注册的设备在线，其他设备被踢下线
- 离线登录的设备（无 token）需服务器恢复后通过心跳自动重连

**建议**：服务器重启前通知其他设备用户，避免数据同步中断。

### 离线登录

服务器不可达时可离线登录，阅读、笔记、AI 分析（直连 API）不受影响。服务器恢复后自动重连并同步数据。离线期间无法跨设备同步。AI 问答和范围总结的结果按小说独立保存，切换小说不丢失。

未配置服务器地址且页面由后端伺服（同源模式）时，自动以当前源作为服务器地址；GitHub Pages 前端未配置时保持离线模式。

---

## 使用教程

### 1. 登录

首次访问弹出登录框：

1. **输入用户名**（2-30 字符），选择「创建并进入」或选择已有用户
2. **配置服务器地址**（可选）：点击「配置」输入后端地址——`192.168.1.100` 自动补全 `http://…:5173`；`https://192.168.1.100` 自动补全 `:8443`（mkcert）。不配置则为离线模式（同源模式下无需配置）

> 数据始终以浏览器本地为主，服务器仅用于备份和跨设备同步。服务器不可达时，「创建新用户」可正常创建本地账户，「加入已有」需服务器在线才能拉取数据。
>
> 同一用户名在不同设备上各自独立。首次同步时若检测到服务器已有同名用户，会提示冲突，用户可选择改名或合并数据。
>
> 切换用户时，若有本地数据会询问保留或丢弃。

### 2. 配置 AI

右上角设置 → 支持 OpenAI 和 Anthropic 格式的接口 → 填写 API Key 和模型名称 → 保存。

- API Key 仅存在浏览器本地 IndexedDB，不经过第三方
- API 设置按用户名隔离，同一浏览器不同用户互不干扰
- 退出登录、切换用户后 API 设置不丢失
- API 请求优先从浏览器直连服务商，部分提供商（如 Anthropic）因 CORS 限制会自动通过服务器代理转发
- 支持 40+ 常用模型的 token 限制自动匹配

### 3. 上传小说

书架页面拖拽 TXT/EPUB 文件，或点击"从文件夹导入"批量导入。支持编码自动检测（GBK / Big5 / UTF-8），智能识别章节标题。

- 小说优先保存到本地 IndexedDB，服务器在线时自动同步到书库
- 服务器不可达时小说仍可正常使用，服务器恢复后自动上传
- 上传的小说自动存入服务端书库，其他人可见，需要手动加入书架

### 4. 阅读

点击书架上任意小说进入阅读视图：
- 左侧目录切换章节，底部导航翻章，键盘 `←` `→` 上下章
- **智能章节加载**：首次进入只加载当前章节附近 ±10 章，大幅减少内存占用，快速启动
- **目录自动滚动**：使用导航按钮切换章节时，左侧目录自动滚动到当前章节位置
- **三种阅读模式**（Aa 按钮切换）：
  - **滚动模式**：传统滚动阅读，支持无限连续滚动（滚动到底部自动加载下一章）
  - **单页模式**：翻页阅读，点击左右两侧 / 滚轮 / 键盘 `←` `→` `Space` 翻页
  - **双页模式**：书本效果，左右两页并排显示（仅桌面端 ≥1024px）
- **沉浸阅读模式**：按 `i` 键切换，隐藏目录栏和 AI 面板，只显示标题和正文
- Aa 按钮调节阅读模式、字体大小、粗细、行距、段距、字体（系统默认 / 宋体 / 楷体 / 等宽）
- 支持暗色 / 亮色模式
- 移动端响应式适配，自动切换为单页模式
- 键盘快捷键：`Shift + ?` 查看全部快捷键

**自动阅读**（📖 按钮，三种模式均支持）：
- 滚动模式：正文持续匀速流动，视口中线基准线 + 当前行高亮追视；顶栏快捷调速（0.5-4 行/秒），开启时缓启动平滑提速
- 单页 / 双页模式：定时自动翻页，页内倒计时进度条提示剩余时间，翻页淡入过渡消除跳变
- 读到章末自动进下一章，全书末尾自动停止并提示；任何手动操作（点击/滑动/翻页/朗读）立即让位停止
- 自动阅读期间保持屏幕常亮；沉浸模式 + 自动阅读时底部悬浮停止按钮

### 5. AI 分析

阅读页右上角打开 AI 分析面板：

| 功能 | 说明 |
|------|------|
| 本章分析 | 生成当前章节摘要（核心情节、关键人物、伏笔） |
| 批量总结 | 批量生成所有章节总结，支持跳过已有总结、随时停止 |
| 全书总览 | 故事主线、主题分析、结构特点、阅读建议 |
| 人物关系 | 角色识别 + 家族/阵营/情感关系图谱（可拖拽、缩放、全屏、悬停显示角色描述、导出图片/JSON） |
| 剧情时间线 | 15-25 个关键事件，标注类型和因果关系 |
| 小说地图 | AI 分析地理位置和势力分布，生成可视化地图（支持拖拽、缩放、全屏、导出） |
| AI 问答 | 多轮对话，基于语义检索定位小说内容（新消息在上），对话记录按小说独立保存，切换小说/返回书架不丢失 |
| 范围总结 | 自定义章节区间（如第 5-15 章）的临时分析，结果按小说独立保存 |
| 笔记 | 章节笔记 + 全书笔记，AI 回答一键收藏 |
| 语义搜索 | 基于 RAG 引擎的全文语义检索，支持自然语言查询 |

**AI 功能特性**：
- **并发控制**：同一时间只能执行一个 AI 功能，其他按钮自动禁用
- **批量总结**：支持确认框、停止功能、跳过已有总结
- **实时状态**：状态栏显示当前阶段和进度
- **智能采样**：长文本自动识别关键段落，优先保留重要内容
- **分段分析**：超长文本自动分段分析后合并，避免信息丢失
- **用户提示**：分析结果会提示是否使用了精简模式

### 6. RAG 检索引擎

项目支持**任意 Transformers.js 兼容的 ONNX 嵌入模型**作为语义检索引擎，同时内置 TF-IDF 作为零配置回退。所有模型需从网络下载（默认使用国内镜像 hf-mirror.com），下载后缓存到浏览器。

| 引擎 | 大小 | 说明 |
|------|------|------|
| TF-IDF | 0 MB | 纯字符级检索，始终可用，无需下载 |
| BGE Small ZH | ~26 MB | 中文语义检索，推荐中文小说（**默认引擎，登录时自动下载**） |
| GTE Small | ~34 MB | 中英文均衡 |
| Multilingual E5 Small | ~120 MB | 中英文兼顾，多语言场景 |
| All-MiniLM-L6-v2 | ~23 MB | 英文轻量，体积最小 |
| Multilingual MiniLM L12 | ~120 MB | 多语言深度理解 |

- **登录时自动下载 BGE**：默认引擎，后台静默下载，Header 显示进度
- **其他引擎**：设置页点击「下载」，同一时间只能下载一个
- **每本书使用前需手动构建**：书架卡片点击"构建"按钮，服务端异步处理（离线时不可用）
- **二进制向量传输**：服务端直接返回 Float32Array 二进制数据，客户端零拷贝加载，无需 JSON 解析
- 构建完成后自动下载到浏览器 IndexedDB 缓存
- 未就绪时自动降级为 TF-IDF，不影响使用
- 设置页可切换引擎和调整索引缓存上限
- 设置页可调整 RAG 检索数量

#### 缓存管理

| 层级 | 存储 | 容量 | 说明 |
|------|------|------|------|
| 内存 LRU | JavaScript 内存 | 固定 100 MB | 最近使用的索引，淘汰后可从 IndexedDB 重新加载 |
| IndexedDB | 浏览器数据库 | 100-500 MB（用户可调） | 持久化缓存，关闭浏览器后保留 |

- 内存 LRU 淘汰时只释放内存，IndexedDB 数据保留
- IndexedDB 超限时自动淘汰最久未使用的条目（保护当前阅读的小说）
- 设置页显示当前 IndexedDB 使用量和进度条
- 书架卡片显示向量数量和缓存大小（如：`5.2k向量 · 7.5MB`）

### 7. 多设备同步

同一用户名登录后自动同步：阅读进度、AI 总结、笔记。

- **数据以浏览器本地为主**，服务器仅用于备份和跨设备同步
- 服务器重启后客户端自动重注册，无需手动重新登录
- 断线恢复时自动拉取服务器最新数据，并弹出提示通知
- 离线创建的小说在服务器恢复后自动上传到书库
- 删除的小说和笔记通过软删除同步，确保多设备一致
- 大量数据自动分批同步，避免超时
- **单设备在线**：同一用户名只允许一台设备在线，新设备登录时旧设备自动下线

> 主题、字体和 API 配置不同步，每台设备 / 每个用户独立存储。

### 8. 离线模式

**自动检测**：心跳每 15 秒检测服务器状态。连续 3 次失败（约 45 秒）自动进入离线模式，服务器恢复后自动退出。离线状态刷新后保留，心跳继续在后台尝试重连。

**手动切换**：Header 点击离线标识可查看状态并切换。

| 标识 | 颜色 | 含义 |
|------|------|------|
| 🟢 在线 | 绿色 | 服务器正常连接 |
| 🟡 离线 | 琥珀色 | 服务器不可达，后台自动重连中 |
| 🔵 手动离线 | 蓝色 | 用户主动开启，不自动重连 |

| 功能 | 离线可用 | 说明 |
|------|---------|------|
| 阅读小说 | 是 | 从本地 IndexedDB 加载 |
| AI 总结/问答 | 是 | 浏览器直连 LLM API（部分提供商可能受 CORS 限制） |
| TF-IDF 搜索 | 是 | 纯本地构建 |
| 嵌入引擎搜索 | 仅已缓存 | 未缓存时自动降级 TF-IDF |
| 笔记 | 是 | 本地 CRUD |
| 上传小说 | 是 | 保存本地，服务器恢复后自动同步 |
| 构建索引 | 否 | 按钮自动禁用，提示"离线不可用" |
| 书库浏览 | 否 | 按钮自动禁用，提示需要服务器在线 |

### 9. 导出 / 备份

设置页提供数据导出功能：
- **导出全部数据**：所有小说、摘要、笔记（不含 API Key）→ JSON 文件
- **单本导出**：下拉选择小说 → JSON 或 TXT 格式
- **导入备份**：从 JSON 文件恢复数据
- **存储用量**：显示浏览器已用 / 可用空间，接近上限时警告

### 10. 管理后台

```bash
./admin.sh       # Linux / macOS
admin.bat        # Windows 双击
```

自动启动服务并打开管理页面：
- **用户管理**：查看 / 删除用户，显示每本小说的地图数和图谱数
- **小说管理**：查看 / 删除小说，调整 RAG 构建超时（最高 120 分钟）
- **统计概览**：总用户数、总小说数、总总结数、总地图数、总图谱数

---

## 键盘快捷键

**滚动模式**：

| 快捷键 | 功能 |
|--------|------|
| `←` / `→` | 上一章 / 下一章 |
| `+` / `-` | 增大 / 减小字号 |
| `i` | 切换沉浸模式 |

**翻页模式**（单页/双页）：

| 快捷键 | 功能 |
|--------|------|
| `←` / `→` / `Space` | 上一页 / 下一页 |
| `+` / `-` | 增大 / 减小字号 |
| `i` | 切换沉浸模式 |

**全局**：

| 快捷键 | 功能 |
|--------|------|
| `t` | 切换主题 |
| `Esc` | 关闭弹窗 |
| `Shift + ?` | 显示快捷键帮助 |

---

## 核心架构

```
前端：GitHub Pages（React 19 + TypeScript + Vite + Tailwind CSS + Zustand）
后端：本地服务器（Express + better-sqlite3），HTTP :5173 / HTTPS :8443（mkcert）双端口并存
├─ 前后端分离：前端通过用户配置的服务器地址连接后端；同源部署时自动回退当前源
├─ 同源模式：--full 且存在 dist 时后端伺服前端（/ 302 → /ai-novel-reader-v2/），
│  子路径结构与 GitHub Pages 完全一致（SW 作用域 / COI / manifest 依赖它）
├─ 多 Agent 引擎：总结 / 人物 / 时间线 / 图谱 / 地图（实时状态反馈）
├─ 多引擎语义检索：BGE / E5 / MiniLM / GTE 等 ONNX 模型（Worker Thread 编码）
├─ d3-force 人物关系图谱（鼠标滚轮 + 移动端双指缩放）
├─ SVG 小说地图（地理位置、势力分布、拖拽缩放、导出 PNG）
├─ 三种阅读模式：滚动（无限连续）/ 单页翻页 / 双页书本效果
├─ 智能章节懒加载（当前 ±10 章，按需加载，减少内存占用）
├─ RAG 向量二进制传输（Float32Array 直传，零拷贝加载）
├─ IndexedDB 浏览器缓存 + SQLite 服务端持久化
├─ PWA Service Worker 离线缓存
├─ 用户名系统 + Session Token 认证 + 服务端中心化同步（自动重注册）
├─ 三级 RAG 缓存：内存 LRU（100MB）→ IndexedDB（100-500MB）→ 服务端 SQLite
├─ 定时 WAL checkpoint + 自动数据库备份（24h）
└─ 质量闸门：`npm run verify` = tsc 双配置 + ESLint（含 server/，零警告）+ 单测（Vitest + Testing Library）+ 五个服务端探针；用例数以运行结果为准
```

---

## 设计原则

- **数据以浏览器本地为主**：阅读、笔记、总结、设置、API Key 全部存在本地 IndexedDB
- **服务器仅在必要时参与（RAG 构建、数据同步、书库共享、模型/API 代理）**：服务器不可达时核心功能（阅读、总结、问答、本地搜索）正常工作
- **登录是本地操作**：用户名检测在浏览器完成，服务器仅在同步时参与
- **离线优先**：自动检测服务器状态，离线时明确提示不可用功能，不阻塞用户操作

---

## 安全机制

- **Session Token 认证**：登录后服务端颁发 Token，所有同步接口（push / heartbeat）均验证 Token
- **自动重注册**：服务器重启或 Token 失效时，客户端自动以已有用户名重新加入，获取新 Token 并拉取全量数据
- **单设备在线**：同一用户名新设备登录时旧设备自动下线
- **API Key 本地隔离**：按用户名存储在 IndexedDB，不上传服务器，不同步，被踢下线时自动保留
- **CORS 白名单**：仅允许 localhost、局域网 IP（http/https）和 `*.github.io` 域名访问
- **CSP 安全策略**：限制 `connect-src` 仅允许 HTTP/HTTPS 协议请求
- **请求限流**：RAG 构建、编码等高开销接口按 IP 限频
- **输入校验**：用户名长度限制、请求体大小限制（50MB）、文本长度限制
- **时间戳合并**：同步时按时间戳判断新旧，避免覆盖更新数据
- **同步互斥锁**：防止并发同步导致数据丢失
- **孤儿记录清理**：同步时自动跳过不存在的小说关联数据，删除小说时级联清理 RAG 缓存

---

## 注意事项

- **后端仅限局域网 / 本地使用，不要暴露到公网**。项目无密码认证、SQLite 不适合公网并发，暴露后存在 API Key 泄露、会话劫持、数据损坏等风险。前端部署在 GitHub Pages 是安全的，敏感数据（API Key）仅存储在浏览器本地
- **mkcert 根证书（rootCA.pem）是敏感文件**：它能为任意域名签发受信证书。传给家人/自己的设备后请删除中转记录，不要公网传播
- 大长篇（5000+ 章）BGE 首次构建可能需要 5-30 分钟，构建期间不影响正常阅读
- 服务端模型加载需要 ~2GB 内存峰值
- 同一台服务器多用户同时构建时自动排队，最多 10 个任务
- API Key 仅存在浏览器 IndexedDB，不会上传到服务器
- 调试面板默认关闭，移动端自动隐藏

---

## 浏览器支持

| 浏览器 | 状态 |
|--------|------|
| Chrome / Edge 86+ | 完全支持 |
| Firefox 120+ | 文件夹导入需手动选择文件 |
| Safari 15+ | 基本功能（iOS 连接后端见「iOS / iPadOS 连接指南」） |
| 移动端 Chrome / Safari | 响应式适配 |

---

## 开源协议

MIT License

---

## 语音朗读（TTS）

提供两种朗读引擎：浏览器内置的 **Web Speech API**（免下载、即开即用）和项目自带的 **Kokoro 离线引擎**（sherpa-onnx 1.13.6 WASM，中英双语、可选音色、完全离线）。

### Web Speech（浏览器内置）

点击顶栏的 ▶ 朗读按钮，当前章节自动分段朗读。

**功能特性：**

- **段落高亮跟随**：当前朗读的段落自动高亮并滚动到可见区域
- **预队列无缝播放**：相邻段落预队列，消除段落间停顿
- **短段合并**：相邻短段落自动合并朗读，减少 utterance 数量
- **语速调节**：0.5x ~ 3.0x，弹窗选择，修改后立即生效
- **睡眠定时**：15/30/60/90 分钟定时关闭
- **自动翻章**：当前章播放完毕自动播放下一章
- **进度条跳转**：点击进度条跳到指定段落
- **移动端适配**：播放栏、弹窗面板均适配移动端

> **已知限制**：Android 版 Edge 的 Web Speech API 存在浏览器自身缺陷——speak() 可以出声，但 getVoices() 永远返回空列表，因此**无法选择音色**，只能使用系统默认语音。遇到此情况请切换到下方的 Kokoro 离线引擎。

### Kokoro 引擎（服务端推理 & 浏览器推理）

基于 sherpa-onnx 1.13.6 的 Kokoro multi-lang v1.0 **fp32** 模型（53 音色，中文 8 音色：女声晓北/晓妮/晓晓/晓伊，男声云健/云希/云夏/云扬）。**两种推理模式**（设置页可切换）：

| 模式 | 推理位置 | 速度 | 依赖 |
|---|---|---|---|
| **服务端推理**（推荐） | 服务器 Python（sherpa-onnx 原生多线程，8 线程） | RTF≈0.6，18 字约 2.5s，**可边听边推理** | 服务器装 Python + `pip install sherpa-onnx` |
| **浏览器推理** | 浏览器 WASM（离线） | RTF≈12，29 字约 69s | 浏览器下载模型（约 380MB）一次，之后完全离线 |
| Web Speech | 浏览器内置 | 实时 | 免下载，Android 部分版本无法选音色 |

**模型按需下载：** 模型（约 350MB）不再随后端启动自动下载，而是**在设置页选择对应推理模式后，点击「启用」按钮才下载**——服务端推理下载到服务器（一次，多用户共享），浏览器推理下载到浏览器 IndexedDB（每设备一次）。未启用时不占带宽/磁盘。

**三层下载链路：**

1. **模型源**：WASM 引擎（含精简 espeak-ng-data）从 Gitee release `Kokoro_fp32_v1.0` 下载；模型（Kokoro v1.0 fp32，约 310MB）优先从 Gitee 同 release 下载 7z 分卷（国内快），失败自动降级 GitHub 官方 tts-models release（含 gh-proxy / gh.llkk.cc 加速镜像）
2. **服务器缓存**（server/data/tts-cache/）：设置页启用服务端推理时自动下载（SSE 进度），也支持手动 /api/rag/tts/prepare
3. **浏览器缓存（IndexedDB）**：设置页启用浏览器推理时自动拉取（带鉴权，逐文件），只需一次，之后完全离线

> **⚠️ 重要：不要使用 int8 模型**。Kokoro v1.0 int8（model.int8.onnx，114MB）在 1.13.6 wasm 上会生成**全 NaN 音频**（生成/播放链路正常但听不到声音）。必须使用 fp32 包（model.onnx，310MB）。

**服务端推理部署要求：**

- 服务器安装 Python 3.9+：`pip install sherpa-onnx`（约 30MB，原生多线程推理）
- 首次在设置页启用时下载模型到服务器（约 350MB，仅一次，之后所有用户共享）
- 后端需能访问 Gitee（国内源）与 GitHub（模型官方源）

---

## 常见问题

### npm install 失败，提示 better-sqlite3 编译错误

**原因**：`better-sqlite3` 是原生模块，Node.js 24+ 没有预编译二进制。本项目要求 Node.js 18-22 LTS。

**解决方案（任选其一）**：

1. **用 nvm 安装 Node.js 22 LTS**（推荐）
   - Windows：下载安装 [nvm-windows](https://github.com/coreybutler/nvm-windows/releases)
   - macOS/Linux：终端运行 `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash`
   - 安装后重启终端，执行：
     ```bash
     nvm install 22       # 安装 Node 22 LTS
     nvm use 22           # 切换到 Node 22
     ```

2. **直接安装 Node.js 22 LTS**（不用 nvm）
   - 卸载当前 Node.js
   - 从 https://nodejs.org 下载 22.x.x LTS 版本安装

### mkcert 安装问题

**安装命令**（需管理员权限）：

```powershell
winget install FiloSottile.mkcert    # Windows
brew install mkcert                  # macOS
sudo apt install mkcert              # Linux
```

**"已安装的现有包，找不到可用的升级"，但 mkcert 命令不存在？**

winget 注册信息残留（安装记录在、可执行文件已丢）。用**普通（非管理员）权限**清理后重装：

```powershell
winget uninstall FiloSottile.mkcert   # 普通权限执行；管理员权限会报"user scope cannot be uninstalled"
winget install FiloSottile.mkcert
```

**装好后命令找不到？** 关掉终端重开一个（PATH 重载），再试 `mkcert --version`。

**`mkcert -install` 失败？** 需要管理员权限：Windows 右键 PowerShell"以管理员身份运行"；macOS/Linux 用 `sudo`。

**`server/data/` 里只有 cert.pem/key.pem，没有 rootCA.pem？** 正常现象——根证书固定在 mkcert 的 CAROOT 目录，不在项目里。运行 `mkcert -CAROOT` 查看位置（Windows 默认 `%LOCALAPPDATA%\mkcert`），取该目录下的 `rootCA.pem`。服务器首次生成证书时会把根证书复制一份到 `server/data/rootCA.pem`，若没有可手动复制。

### 升级版本后页面行为异常（旧缓存）

前端带 PWA Service Worker 缓存。服务器更新后，浏览器可能仍在跑旧版缓存代码（典型症状：控制台请求不存在的旧路径 404）。

**解决**：硬刷新（Ctrl+Shift+R），或在 DevTools → Application → Storage → Clear site data。iOS：设置 → Safari → 清除历史记录与网站数据。项目自身也有两道兜底：SW 更新时自动清理过期缓存（`cleanupOutdatedCaches`）、前后端版本不一致时弹提示对话框。

### 浏览器控制台显示 mixed content 警告

**原因**：GitHub Pages（HTTPS）前端向 HTTP 后端发请求，浏览器显示黄色警告。

**影响**：桌面浏览器仅是警告，**不会阻止请求**，所有功能正常工作。**iOS Safari 会直接阻断请求**（无放行选项），必须改用 HTTPS 后端或同源模式，见「iOS / iPadOS 连接指南」。

### 前端无法连接后端

**检查清单**：
1. 后端是否已启动（终端显示 `[sync] http://0.0.0.0:5173`）
2. 服务器地址协议与端口是否匹配：`http://` 对应 `:5173`，`https://` 对应 `:8443`（两种端口同时监听）
3. **iOS 设备**：HTTP 后端 + GitHub Pages 前端的组合会被平台阻断，改用同源模式或 mkcert HTTPS
4. 换过 Wi-Fi / IP 变化后连不上 HTTPS？重启后端即可自动重签证书（启动时检测 IP 变化；仅重签失败时才需手动删除 `server/data/cert.pem`、`key.pem` 再重启）
5. 前端和后端是否在同一局域网；防火墙是否放行 5173/8443 端口
6. 手机已装 rootCA 还是连不上 HTTPS？十有八九是漏了「证书信任设置」的完全信任开关（设置 → 通用 → 关于本机）。验证方法：手机 Safari 直接访问 `https://<电脑IP>:8443`，无警告（有小锁）才算证书装好；注意应用内请求失败时不弹证书提示，别被"没有任何报错"迷惑

### 如何重新安装依赖

遇到依赖异常或切换 Node 版本后，可删除旧依赖重新安装：

```bash
# Windows CMD
rmdir /s /q node_modules
del package-lock.json
npm install

# macOS / Linux
rm -rf node_modules package-lock.json
npm install
```
