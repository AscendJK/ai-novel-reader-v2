# AI Novel Reader

A browser-based AI-powered novel reading tool. Upload TXT/EPUB files, configure any LLM API, and get chapter summaries, character relationship graphs, plot timelines, AI Q&A, and more. Built-in user system with cross-device sync.

[中文](README.md)

## Quick Start

The project uses a **front-end/back-end separated architecture**: the frontend is deployed on GitHub Pages, and the backend runs on your local machine. The backend listens on HTTP and HTTPS ports at the same time (HTTPS requires mkcert, see below).

### Frontend (GitHub Pages)

The frontend is deployed on GitHub Pages. **No installation required** — just visit:

**https://ascendjk.github.io/ai-novel-reader-v2/**

You can use it without configuring a server (offline mode). Configure a server to enable sync.

### Backend (Local Deployment)

The backend provides RAG building, data sync, book library management, and other services, running on your own machine.

**Prerequisites**:
- [Node.js](https://nodejs.org) v18~22 LTS (22 recommended)
- [mkcert](https://github.com/FiloSottile/mkcert) (**optional**, enables HTTPS; strongly recommended for iOS users — see the "iOS / iPadOS Connection Guide" below)
- Python 3.9+ (**optional**, only needed for the "Server Inference" TTS engine: `pip install sherpa-onnx`; all other features work without it)

> **Node.js 24+ users**: `better-sqlite3` lacks prebuilt binaries for Node 24, requiring Python 3.x and C++ build tools. We recommend **Node.js 22 LTS**.

**Option 1: Download a backend package (Recommended)**

Download from [Releases](https://github.com/AscendJK/ai-novel-reader-v2/releases) (pick one):

| Package | Size | For |
|---|---|---|
| `ai-novel-reader-v2-backend.zip` | ~115 KB | **Backend only**: use it with the GitHub Pages frontend |
| `ai-novel-reader-v2-full.zip` | ~1 MB | **Frontend + backend**: ships the prebuilt frontend, so an iPhone can reach it same-origin without a certificate |

After extracting:

- **Windows**: Double-click `start.bat`
- **macOS / Linux**: `chmod +x start.sh && ./start.sh`

Both start scripts do three things in order: run `scripts/cleanup-processes.*` to clear node/python processes left over from a previous run (`stop.*` uses the same cleanup) → install dependencies (the 5 backend ones only; the package ships `package-lock.json`, so this is `npm ci` and you get exactly the versions verified before release — it falls back to `npm install` only when the lock is missing or `npm ci` fails) → `node server/index.js`. The difference is that the full package's scripts pass `--full` and serve `dist/` — **no build step needed**.

The package's `admin.bat` / `admin.sh` install dependencies the same way when `node_modules` is missing. The same now holds in the source repo: `start.bat` / `start.sh` and `admin.bat` / `admin.sh` run `npm ci` against the repository's own `package-lock.json` (that's the frontend dependency set) and fall back to `npm install` only when the lock is missing or `npm ci` fails.

> **Package contents**: Only `server/` source code (including `tts-worker.py`, the server-inference script), `package.json` (5 backend dependencies), `package-lock.json` (pins those 5 versions), start/stop scripts, `scripts/cleanup-processes.*`, and `README.txt` (deployment notes); the full package additionally ships the prebuilt `dist/`. Runtime data (database, model cache, certificates) is created automatically on first server start.
>
> **How to update**: Download the new zip and extract it directly into your existing backend directory, overwriting files. The backend package does **not** include the `server/data/` directory, so your database (novels, notes, reading progress, etc.) is safe. If you modified `start.bat` (e.g., changed the port), you'll need to re-apply your changes after overwriting. If dependencies changed, the script installs them automatically (`npm ci` while the shipped lock is present). The start script also probes for Python + sherpa-onnx (optional) and prints a hint without blocking startup if missing.

**For maintainers: how to build / publish the backend packages**

Build locally (cross-platform; works with PowerShell 7 or Windows PowerShell):

```bash
npm run pack:lock                         # regenerate the shipped lock (package-server-lock.json) after touching backend deps
npm run pack:backend                      # backend package only
pwsh -File pack-backend.ps1 -IncludeDist  # also build the frontend+backend package (run `npm run build` first)
```

They land in the (git-ignored) `release/` directory: `release/ai-novel-reader-v2-backend.zip` (~115 KB) and `release/ai-novel-reader-v2-full.zip` (~1 MB).

Before anything is zipped, `scripts/check-server-pack.mjs` (pure logic in `scripts/lib/pack-gate.mjs`, judged by `src/lib/__tests__/pack-gate.test.ts`, PG1..PG10) aborts the build if any of these is untrue: every local file referenced by a packaged source file — including non-JS assets such as `admin.html` — is present; every shippable file under `server/` made it into the package; the package-root support files (including `package-lock.json`) are all there; and the packed lock still matches the packed dependency list (a stale lock reports "re-run npm run pack:lock").

**Auto-publish a Release**: Pushing to `main` only triggers the frontend deployment — it does not package the backend. To release a new version, create a tag:

```bash
git tag v2.6.0
git push origin v2.6.0
```

GitHub Actions (`.github/workflows/release-backend.yml`) then builds the frontend, packs both zips, verifies the artifacts (checks critical files such as `tts-worker.py`, `rag.js`, and — for the full package — `dist/index.html`; fails the run if any is missing), creates a Release, and uploads them. You can also trigger it manually from the Actions tab (workflow_dispatch).

**Option 2: Clone the entire repo**

```bash
git clone https://github.com/AscendJK/ai-novel-reader-v2.git
cd ai-novel-reader-v2
```

- **Windows**: Double-click `start.bat`
- **macOS / Linux**: `chmod +x start.sh && ./start.sh`

The script will auto-install dependencies, build the frontend, and start the server (full mode, including frontend static serving).

The terminal will display:
```
[static] serving ...dist at /ai-novel-reader-v2/ (full mode)
[sync] https://0.0.0.0:8443 (full)   <- when mkcert is installed
[sync] http://0.0.0.0:5173 (full)
```

### Connection Modes (frontend ↔ backend)

One backend instance supports all of the modes below at the same time — pick by scenario:

| Mode | Where the page comes from | Server address to enter | iOS Safari | Certificate | SW offline shell |
|---|---|---|---|---|---|
| ① Pages + HTTP backend | GitHub Pages | `http://IP:5173` | ❌ blocked by the platform | not needed | works (Pages side) |
| ② Pages + HTTPS backend (**recommended for iOS**) | GitHub Pages | `https://IP:8443` | ✅ | needed (mkcert) | works (Pages side) |
| ③ Same-origin HTTP | served by the backend | nothing (same origin) | ✅ | not needed | unavailable¹ |
| ④ Same-origin HTTPS | served by the backend | nothing (same origin) | ✅ | needed (mkcert) | works |

¹ Secure-context rule: over plain HTTP to a LAN IP the browser refuses to register a Service Worker (see the note at the end of the iOS guide).

- **Mode ①**: fully usable on desktop browsers (a yellow console warning, nothing is blocked); only unusable on iOS.
- **Mode ②**: the most complete — the Pages shell stays on the public internet (the app still opens with your computer off), and full sync works while the server is running.
- **Modes ③④**: open `http://IP:5173/ai-novel-reader-v2/` (or https on 8443) directly. Page and API share one origin, so **there is no server address to configure** — it connects to the local backend automatically.

**Configure the frontend** (modes ①②):

1. Open the frontend page
2. On the login screen, click "Configure", enter the backend address, and pick a "Connection type" (HTTP :5173 / HTTPS :8443)
3. Click "Save & Connect" — "Connected" means success

> **What you pick is what it connects to**: HTTP is the default. A bare IP such as `192.168.1.100` is completed along the selected leg into `http://192.168.1.100:5173` or `https://192.168.1.100:8443`, and the app **no longer silently retries the other leg** — if both ports are listening, switch with the two buttons; switching re-probes along the new leg immediately.
> If the address itself carries a scheme (`https://192.168.1.100`), **what is in the box is what gets saved and connected** — the two buttons show that same scheme, and clicking one swaps the leading scheme to your pick (`https://192.168.1.100` + HTTP → `http://192.168.1.100:5173`). A port you typed yourself (`192.168.1.100:9000`) is kept as typed; only the other leg's default port follows the switch.

> **Connecting from GitHub Pages to a local or LAN device**: Chrome/Edge ask once for "allow access to devices on your local network". The grant is remembered for that site — allow it once. If you denied it earlier and can't connect, click the permission icon in the address bar and allow it. On desktop browsers an HTTPS page reaching a LAN `http://IP:5173` only logs a yellow warning and works; **iOS Safari blocks it outright** — use mode ② or same-origin on iOS.

> **How to find the server IP**: Windows: run `ipconfig`, macOS/Linux: run `ifconfig` or `ip addr`, look for the LAN IPv4 address.

### Development Mode (Optional)

For local frontend development, start frontend and backend separately:

```bash
# Terminal 1: Start backend
npm run server

# Terminal 2: Start frontend dev server
npm run dev
```

Frontend dev server runs at `http://localhost:5174`, API requests are automatically proxied to the backend at `localhost:5173`.

---

## iOS / iPadOS Connection Guide

On iOS **every browser** (including third-party ones like Chrome and Firefox — all WebKit) has two platform-level limits:

1. **Mixed content blocking**: an HTTPS page (GitHub Pages) cannot request an HTTP backend. Unlike Chrome/Edge, Safari offers no "load unsafe content" override, and `http://127.0.0.1` / `http://localhost` are not exempt either (WebKit bug 171934, unfixed for years).
2. **Service Workers only in secure contexts**: a plain-HTTP LAN page cannot register a SW — which means no offline shell and no PWA caching on HTTP pages.

So iOS users have two working paths, depending on whether you are willing to install a certificate once:

### Path A: same-origin HTTP (no certificate, simplest)

Run the server in full mode, then open this in iPhone Safari:

```
http://<computer-IP>:5173/ai-novel-reader-v2/
```

- ✅ No certificate, no installation; opens straight away, and after login it connects to the local backend automatically
- ❌ The page is unreachable when the computer or server is off (no SW offline shell)
- On first visit iOS may ask for "Local Network" permission — tap Allow

### Path B: mkcert HTTPS (recommended, full functionality)

Install an mkcert certificate once and you get a trusted `https://<computer-IP>:8443` entry point:

- ✅ The GitHub Pages frontend connects normally (mode ②)
- ✅ Same-origin HTTPS (mode ④), SW offline shell works — the app still opens and reads offline after the server is stopped
- Cost: one 5-minute setup per iOS device

**Install mkcert on the computer** (once):

```bash
# Windows (winget; if it says "already installed" but mkcert is not found, see the FAQ below)
winget install FiloSottile.mkcert

# macOS
brew install mkcert

# Linux (Debian/Ubuntu)
sudo apt install mkcert
```

Then initialize the local CA (**requires admin/sudo privileges, only once**):

```bash
mkcert -install
```

Restart the backend (`start.bat`) and confirm the startup log shows `https://0.0.0.0:8443`.

**When the server IP changes**: the mkcert certificate is issued for the IP the machine had when it was generated. After switching Wi-Fi / changing IP, **just restart the backend** — on startup it checks whether the current IP is covered by the certificate and re-issues it automatically if not (`rootCA.pem` and the copy installed on your phone are untouched). Only if the log says automatic re-issuing failed (mkcert unavailable) do you need to delete `server/data/cert.pem` and `server/data/key.pem` and restart.

**Where the certificate files live**:

| File | Location | Purpose |
|---|---|---|
| `rootCA.pem` | the directory printed by `mkcert -CAROOT` (Windows default: `%LOCALAPPDATA%\mkcert`) | **this is the one you install on phones / other devices** |
| `rootCA-key.pem` | same directory | root CA private key — **never hand this out** |
| `cert.pem` / `key.pem` | `server/data/` | server HTTPS certificate (generated automatically on startup for the current IP) |
| `rootCA.pem` (copy) | `server/data/` (copied automatically the first time a certificate is generated) | same file as in CAROOT, convenient to grab |

**Trust the root certificate on other devices**:

- **Windows**: double-click `rootCA.pem` → Install Certificate → Trusted Root Certification Authorities
- **macOS**: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain rootCA.pem`
- **Android**: Settings → Security → Encryption & credentials → Install a certificate → CA certificate
- **iOS**: the two-stage flow below

**Full mkcert uninstall** (when you stop using HTTPS):

```bash
# 1. Remove the local CA from the system trust store (admin required; this invalidates the certificates on your phones)
mkcert -uninstall

# 2. Uninstall the program itself
winget uninstall FiloSottile.mkcert      # Windows (normal privileges are enough)
brew uninstall mkcert                    # macOS
sudo apt remove mkcert                   # Linux

# 3. Delete the root certificate files (in the CAROOT directory: rootCA.pem and rootCA-key.pem)
mkcert -CAROOT                           # print the path first, then delete that directory

# 4. (Optional) clean up the server-side certificates this project generated
#    delete cert.pem, key.pem, rootCA.pem under server/data/
#    after a restart the backend falls back to plain HTTP
```

> After uninstalling: on the computer the CA disappears with `mkcert -uninstall`; **on an iPhone that already installed it you must delete the profile by hand** (Settings → General → VPN & Device Management → mkcert → Delete Profile, then confirm it is gone under "Certificate Trust Settings"), otherwise the phone still reports it as trusted while the server can no longer serve HTTPS.

**Install the root certificate on the iPhone** (once per device). The flow has **two mandatory stages**: ① install the profile → ② turn on full trust. After stage ① iOS says "Installed" and appears to be finished, but the certificate is **still not trusted** at that point — skipping stage ② is the single most common reason HTTPS fails to connect:

1. Get `rootCA.pem` onto the iPhone (AirDrop does not work for certificate files; WeChat/QQ/email all do — **delete the file and the chat message afterwards**, a root certificate is sensitive material).

   **Where rootCA.pem is**: the server certificates mkcert generates (cert.pem/key.pem) land in `server/data/`, but **the root certificate always lives in mkcert's CAROOT directory**, it does not travel with the project:

   ```bash
   mkcert -CAROOT    # prints the directory; Windows default: %LOCALAPPDATA%\mkcert
   ```

   Take `rootCA.pem` from there. The server also copies it to `server/data/rootCA.pem` the first time it issues a certificate (if that file exists you can use it directly); both sources are equivalent.
2. **Stage ①: install the profile.** Tap the file on the iPhone → Settings opens at "Profile Downloaded" → Settings → General → VPN & Device Management → Install.
   ⚠️ "Installed" only means stage ① is done — the certificate is not working yet. Go straight to stage ②.
3. **Stage ②: enable full trust.** Settings → General → About → **Certificate Trust Settings** → switch the mkcert entry on.
   ⚠️ **This is the step that matters; skip it and the installation was pointless**: iOS keeps it as a separate switch, buried under "About", and the install flow never points you to it. Without it, opening the backend address in Safari shows a certificate warning, while requests from inside the app (the server address on the login screen) **produce no prompt at all and just fail silently** — exactly the "I installed the certificate and it still won't connect" case.

**Verify**: open the GitHub Pages frontend in Safari → set the server address to `https://<computer-IP>:8443` → you should see "Connected" with no certificate warning; or open `https://<computer-IP>:8443/ai-novel-reader-v2/` directly (same-origin HTTPS).

### Connecting over a USB cable (fallback when there is no Wi-Fi)

Plug the iPhone into the computer with a cable and turn on **Personal Hotspot** (Settings → Personal Hotspot → Allow Others to Join). Windows recognises USB tethering as a network adapter, putting phone and computer on the `172.20.10.x` segment — the phone's Safari can then open `http://172.20.10.2:5173/ai-novel-reader-v2/` over the cable (no router involved, no cellular data used).

Notes:
- Windows may classify the USB adapter as a "Public network", so Node.js needs inbound permission on public networks too
- For HTTPS (8443), connect the cable first and then restart the backend so the certificate gets issued for `172.20.10.2`
- iOS does not support the reverse direction (computer borrowing the phone's connection), so don't try it
- This does not change any browser security rule: SW registration and mixed-content behaviour are identical to the Wi-Fi case

> **Why is there no offline option without a certificate?** The Service Worker is what carries offline capability, and browsers only register SWs in secure contexts (HTTPS / localhost) — a plain-HTTP LAN page cannot bypass that. So it is either "no certificate" or "SW offline shell"; installing mkcert is the only way to get both.

---

## Shared Frontend

The frontend is deployed on GitHub Pages — everyone shares the same frontend URL. Each person runs their own backend on their own machine. Data is fully isolated:

- Each backend is independent → databases are isolated
- Each browser's IndexedDB is independent → local data doesn't interfere
- Server address is stored in each person's localStorage → each connects to their own backend

Even if multiple people use the same username, there's no conflict — each connects to their own backend.

> For full independence (including the frontend), fork this repo and deploy to your own GitHub Pages.

---

## Important Notes

### Server Restart

The server stores session data (tokens, online status) in memory. **All sessions are invalidated after a restart**:

- Logged-in devices will automatically detect and re-register, restoring online status with a toast notification
- When using the same username on multiple devices, the first device to re-register stays online; others are kicked
- Devices logged in while offline (no token) will auto-reconnect via heartbeat after the server recovers

**Tip**: Notify other device users before restarting the server to avoid sync interruptions.

### Offline Login

You can log in while the server is unreachable. Reading, notes, and AI analysis (direct API) work normally. Data syncs automatically when the server recovers. Cross-device sync is unavailable while offline. AI Q&A and range summary results are saved per novel — switching novels preserves the conversation.

---

## Usage

### 1. Login

On first visit, a login dialog appears:

1. **Enter a username** (2-30 chars), choose "Create and Enter" or select an existing user
2. **Configure server address** (optional): Click "Configure", enter the backend address and pick the connection type — a bare `192.168.1.100` is completed along the selected leg (HTTP → `:5173`, HTTPS → `:8443`, HTTP is the default) and the other leg is never probed behind your back; a scheme typed into the field wins. Without a server the app runs in offline mode (same-origin deployments need no configuration)

> Data is **browser-first** — the server is only for backup and cross-device sync. When the server is unreachable, "Create New" works normally as a local account. "Join Existing" requires the server to be online to fetch data.
>
> The same username on different devices operates independently. On first sync, if the server already has the same username, a conflict prompt appears — the user can rename or merge data.
>
> When switching users, if local data exists, the user is asked whether to keep or discard it.

### 2. Configure AI

Settings → an endpoint in OpenAI or Anthropic format → enter the API key and model name → save.

- API keys are stored only in your browser's IndexedDB and never pass through a third party
- API settings are isolated per user — different users on the same browser don't interfere
- Settings survive logout, user switching, and browser restarts
- API requests go directly from the browser to the provider. Some providers (e.g., Anthropic) may require the server proxy due to CORS restrictions
- A built-in table of **context windows** for 40+ common models, used to work out how much source text still fits in this request

**The "Max output tokens" field: leave it empty.** When empty, each task asks for the amount it actually needs — range summary and Q&A 2,048; chapter summary 4,096; book overview and character relationship graph 8,192; character analysis, plot timeline and novel map 16,384. If you do fill it in, that number becomes a **shared ceiling** across every task: enter 8,192 and the novel map, which would ask for 16,384, only gets 8,192, so it may stop half way through drawing. Also, within one context window, the more output you reserve the less source text can be fed to the model; whatever cannot be sent is stated on the analysis card (e.g. 「另有 N 章原文没送出去」 — "the original text of N more chapters was not sent"). The app's interface is Chinese-only; quoted strings below are the actual on-screen text with a translation.

You don't have to probe a provider's ceiling either: if `max_tokens` is above what it accepts, the provider answers with its own number (e.g. `should be in [1, 65536]`), and the app shrinks one step accordingly and re-sends, then keeps using that number for the same provider for the rest of the session.

**The "Disable thinking (Thinking)" switch**: reasoning models think before answering by default (the DeepSeek / GLM family), and that thinking is charged against the output budget — if the budget runs out you get thinking only, with not one character of actual answer. Large outputs such as the map and the graph are the first to die here. With this switch on, the re-sent request carries `thinking: disabled` so the model writes the answer directly. **Not every provider honours this parameter** (measured: some still return only thinking), so enabling it is not a guarantee; the app's own automatic retry uses the same switch.

### 3. Upload Novels

Drag TXT/EPUB files onto the bookshelf, or use "Import from Folder" (「从文件夹导入」) for batch import. Supports GBK/Big5/UTF-8 encoding detection and smart chapter recognition.

- **"Import from Folder" counts first, acts later**: picking a folder only lays the batch out on screen (how many books, which files); nothing is parsed until you click "Confirm import N books" (「确认导入 N 本」), which then imports them one by one. Without confirming, not a single book is imported. Over 50 books, the confirm button stays locked until you tick an explicit acknowledgement.
- **There is no "Import from Folder" on iPhone / iPad** (iOS Safari does not implement the File System Access API, and its folder picker would only flatten the whole folder into loose files — the one possible outcome being a pile of misleading files). Use the ordinary file picker instead.
- Novels are saved to local IndexedDB first, then synced to the server library when it is available
- Novels work locally even when the server is unreachable; auto-uploaded when the server recovers
- Uploaded novels are automatically stored in the server library and visible to all users — you still have to add them to your own bookshelf by hand

### 4. Read

Click any novel on the bookshelf to enter reading view:
- Left sidebar navigates chapters, bottom bar for prev/next, keyboard `←` `→` for chapter switching
- **Smart Chapter Loading**: Only loads current chapter ± 10 chapters on entry, significantly reducing memory usage and enabling fast startup
- **Directory Auto-scroll**: When navigating chapters with buttons, the left sidebar automatically scrolls to the current chapter
- **Three Reading Modes** (switch via Aa button):
  - **Scroll Mode**: Traditional scrolling with infinite continuous scroll (auto-loads next chapter at bottom)
  - **Single Page Mode**: Page-by-page reading, click left/right sides / scroll wheel / keyboard `←` `→` `Space` to turn pages
  - **Double Page Mode**: Book-like layout with two pages side by side (desktop ≥1024px only)
- **Immersive Reading Mode**: Press `i` to toggle, hides sidebar and AI panel, shows only title and text
- Aa button adjusts reading mode, font size, weight, line height, paragraph spacing, and font family (system default / Song / Kai / monospace)
- Dark / light mode toggle
- Mobile-responsive, auto-switches to single page mode
- Keyboard shortcut: `Shift + ?` to view all shortcuts

**Auto-reading** (📖 button, works in all three modes):
- Scroll mode: the text flows at a constant speed, the current line is highlighted as it crosses the middle of the viewport; quick speed control in the top bar (0.5-4 lines/second), with a gentle ramp-up when you switch it on
- Single / double page mode: pages turn automatically on a timer, an in-page progress bar counts down the remaining time, and a fade transition removes the jump
- Reaching the end of a chapter advances to the next one; at the end of the book it stops and says so; any manual action (tap / swipe / page turn / read aloud) yields immediately and stops
- The screen stays awake while auto-reading runs; in immersive mode plus auto-reading there is a stop button floating at the bottom

### 5. AI Analysis

Open the AI analysis panel (top-right) in reading view:

| Feature | Description |
|---------|-------------|
| Chapter Summary | Core plot, key characters, foreshadowing for current chapter |
| Batch Summary | Batch generate all chapter summaries, supports skip existing and stop |
| Book Overview | Main storyline, themes, structure, reading advice |
| Characters | Role identification + family/faction/relationship graph (draggable, zoomable, fullscreen, hover for description, export image/JSON) |
| Timeline | 15-25 key events with type annotations and causality |
| Novel Map | AI analyzes geographic locations and faction distribution, generates interactive map (drag, zoom, fullscreen, export) |
| Q&A | Multi-turn conversation with semantic text retrieval (newest first), conversations saved per novel — switching novels preserves history |
| Range Summary | Custom chapter range analysis (e.g. chapters 5-15), results saved per novel |
| Notes | Per-chapter and global notes, one-click bookmark AI responses |
| Semantic Search | RAG-powered full-text semantic search with natural language queries |

**AI Features**:
- **Concurrency Control**: Only one AI function runs at a time, other buttons are automatically disabled
- **Batch Summary**: Confirmation dialog, stop function, skip existing summaries
- **Real-time Status**: Status bar shows current stage and progress
- **Smart Sampling**: Automatically identifies key paragraphs in long texts, prioritizing important content
- **Segmented Analysis**: Long texts are automatically split, analyzed separately, then merged
- **User Notification**: Analysis results indicate if simplified mode was used
- **Self-healing for reasoning models**: when a request returns not one character of answer, the app automatically re-sends it with the model's "thinking" turned off — the first send lets it think (better quality), only the second one goes for the raw answer. **Novel Map** and **Character Graph** recognise one more failure shape of the same kind: the provider cutting the answer off mid-way (the response itself says it hit the output ceiling) also counts as "this send didn't work". Every task caps out at two sends; if both fail, the provider's own words are put on the panel — the app never burns quota indefinitely. The text-only chapter summary, range summary and Q&A deliberately do not retry on truncation: half a sentence is still readable text there.
- **Quota is not wasted**: on errors that a second send cannot fix — rate limiting (429), a dead key (401), an exhausted balance (402) — the app stops after one send and shows the provider's own wording on the panel
- **Errors say what happened**: the panel shows the provider's original message (together with the raw response snippet). When a reasoning model spent the budget on thinking, it says so directly — "the model used N tokens on thinking and returned no answer" — and points at the next step (turn thinking off, or raise the output ceiling). Only when there is genuinely no evidence does it write 「可能原因：模型名称不存在或无权访问…」 ("possible cause: the model name doesn't exist or isn't accessible…") — that line is a fallback, not a diagnosis
- **Tasks outlive the panel**: collapsing the AI panel, switching tabs inside it, or turning chapters does not kill a generation in flight; both "queued" and "running" are shown, and results are saved automatically when they land (even if the person who started it is no longer on that screen — a chapter summary always lands back on the chapter that started it). Only logging out or switching users cancels a task
- **Degradation is visible**: when the map's parent place names don't match, the panel writes 「N 个地点的上级没找到」 ("the parent of N places wasn't found") instead of silently drawing something wrong; the same applies to truncated Q&A history and source text that could not be sent — what's missing is stated on the card

### 6. RAG Engine

Supports **any Transformers.js-compatible ONNX embedding model** for semantic retrieval, with TF-IDF as a zero-config fallback. All models are downloaded from the network (default: hf-mirror.com for China) and cached in the browser.

| Engine | Size | Description |
|--------|------|-------------|
| TF-IDF | 0 MB | Character-level search, always available, no download |
| BGE Small ZH | ~26 MB | Chinese semantic search, recommended (**default, auto-downloaded on login**) |
| GTE Small | ~34 MB | Balanced Chinese + English |
| Multilingual E5 Small | ~120 MB | Chinese + English, multilingual |
| All-MiniLM-L6-v2 | ~23 MB | English lightweight, smallest |
| Multilingual MiniLM L12 | ~120 MB | Deep multilingual understanding |

- **BGE auto-downloads on login**: Default engine, silent background download, progress shown in header
- **Other engines**: Click "Download" in settings, only one download at a time
- Build index per novel via the "Build" button on the bookshelf card (unavailable offline)
- **Binary vector transfer**: Server returns Float32Array binary data directly, client loads with zero-copy, no JSON parsing needed
- Built index downloads to browser IndexedDB cache
- Automatically falls back to TF-IDF if embedding engine is not ready
- Settings page allows switching engines and adjusting cache limits
- Settings page allows adjusting RAG retrieval count

#### Cache Management

| Layer | Storage | Capacity | Description |
|-------|---------|----------|-------------|
| Memory LRU | JavaScript memory | Fixed 100 MB | Recently used indexes, evicted entries can be reloaded from IndexedDB |
| IndexedDB | Browser database | 100-500 MB (user-adjustable) | Persistent cache, survives browser restarts |

- Memory LRU eviction only frees memory, IndexedDB data is preserved
- IndexedDB automatically evicts oldest entries when quota exceeded (protects currently reading novel)
- Settings page shows current IndexedDB usage and progress bar
- Bookshelf card displays vector count and cache size (e.g., `5.2k vectors · 7.5MB`)

### 7. Multi-device Sync

Same username automatically syncs: reading progress, AI summaries, notes.

- **Browser-first data** — server is only for backup and cross-device sync
- Server restart triggers automatic re-registration, no manual re-login needed
- Automatic pull of latest server data on reconnection, with toast notification
- Offline-created novels auto-upload to server library when server recovers
- Deleted novels and notes sync via soft delete, ensuring multi-device consistency
- Large data sets automatically batch sync to avoid timeouts
- **Single-device online**: only one device per username allowed online at a time; new login kicks the old device

> Theme, font, and API config are not synced — each device / each user stores independently.

### 8. Offline Mode

**Auto-detect**: Heartbeat checks server status every 15 seconds. 3 consecutive failures (~45 seconds) auto-enables offline mode, auto-disables when server recovers. Offline state persists across page refreshes; heartbeat continues reconnecting in background.

**Manual toggle**: Click the offline indicator in Header to view status and toggle.

| Indicator | Color | Meaning |
|-----------|-------|---------|
| 🟢 Online | Green | Server connected |
| 🟡 Offline | Amber | Server unreachable, auto-reconnecting |
| 🔵 Manual Offline | Blue | User-initiated, no auto-reconnect |

| Feature | Offline Available | Notes |
|---------|------------------|-------|
| Read novels | Yes | Load from local IndexedDB |
| AI summary/Q&A | Yes | Browser direct to LLM API (some providers may have CORS limits) |
| TF-IDF search | Yes | Pure local build |
| Embedding search | Cached only | Falls back to TF-IDF if not cached |
| Notes | Yes | Local CRUD |
| Upload novels | Yes | Save locally, auto-sync when server recovers |
| Build index | No | Button auto-disabled, shows "Offline unavailable" |
| Library browse | No | Button auto-disabled, requires server online |

### 9. Export / Backup

Settings page provides data export:
- **Export all data**: All novels, summaries, notes (excluding API Key) → JSON file
- **Single novel export**: Select novel → JSON or TXT format
- **Import backup**: Restore data from JSON file
- **Storage usage**: Shows browser used/available space, warns when near limit

### 10. Admin Panel

```bash
./admin.sh       # Linux / macOS
admin.bat        # Windows double-click
```

Auto-starts server and opens admin page:
- **User Management**: View/delete users, display map count and graph count per novel
- **Novel Management**: View/delete novels, adjust RAG build timeout (up to 120 minutes)
- **Statistics Overview**: Total users, total novels, total summaries, total maps, total graphs

---

## Keyboard Shortcuts

**Scroll Mode**:

| Shortcut | Action |
|----------|--------|
| `←` / `→` | Previous / next chapter |
| `+` / `-` | Increase / decrease font size |
| `i` | Toggle immersive mode |

**Pagination Mode** (Single/Double Page):

| Shortcut | Action |
|----------|--------|
| `←` / `→` / `Space` | Previous / next page |
| `+` / `-` | Increase / decrease font size |
| `i` | Toggle immersive mode |

**Global**:

| Shortcut | Action |
|----------|--------|
| `t` | Toggle theme |
| `Esc` | Close dialogs |
| `Shift + ?` | Show shortcut help |

---

## Architecture

```
Frontend: GitHub Pages (React 19 + TypeScript + Vite + Tailwind CSS + Zustand)
Backend: Local server (Express + better-sqlite3), HTTP :5173 / HTTPS :8443 (mkcert) listened on at the same time
├─ Front-back separation: frontend connects to backend via user-configured server address; in same-origin deployment it falls back to the current origin
├─ Same-origin mode: with --full and a dist/ present the backend serves the frontend (/ 302 → /ai-novel-reader-v2/);
│  the sub-path layout matches GitHub Pages exactly (SW scope / COI / manifest depend on it)
├─ Multi-agent engine: summary / characters / timeline / graph / map (live status feedback)
├─ Multi-engine semantic retrieval: BGE / E5 / MiniLM / GTE ONNX models (Worker Thread encoding)
├─ d3-force character graph (mouse wheel + pinch-to-zoom on mobile)
├─ SVG novel map (geographic locations, faction distribution, drag/zoom, PNG export)
├─ Three reading modes: scroll (infinite continuous) / single page / double page book effect
├─ Smart chapter lazy loading (current ±10 chapters, load on demand, reduced memory usage)
├─ RAG vector binary transfer (Float32Array direct transfer, zero-copy loading)
├─ IndexedDB browser cache + SQLite server persistence
├─ PWA Service Worker offline caching
├─ Username system + Session Token auth + server-side centralized sync (automatic re-registration)
├─ Three-tier RAG cache: Memory LRU (100MB) → IndexedDB (100-500MB) → Server SQLite
├─ Periodic WAL checkpoint + automatic database backup (24h)
└─ Quality gate: `npm run verify` = tsc (two configs) + ESLint covering server/ with zero warnings + unit tests (Vitest + Testing Library) + five server probes; test counts are whatever the run reports
```

---

## Design Principles

- **Browser-first data**: Reading, notes, summaries, settings, and API keys all live in local IndexedDB
- **Server participates only when needed (RAG building, sync, shared book library, model/API proxy)**: Core features (reading, summaries, Q&A, local search) work when the server is unreachable
- **Login is local**: Username validation happens in the browser; the server only participates in sync
- **Offline-first**: Auto-detects server status, clearly indicates unavailable features, never blocks the user

---

## Security

- **Session Token authentication**: Server issues tokens on login, sync endpoints (push/heartbeat) also verify tokens
- **Single-session enforcement**: Logging in from a new device kicks the previous session; automatic re-registration after server restart
- **API key local isolation**: Stored per-user in IndexedDB, never uploaded, never synced, preserved on kick
- **CORS allowlist**: Only localhost, LAN IPs, and `*.github.io` domains allowed
- **CSP security policy**: `connect-src` restricted to HTTP/HTTPS protocols only
- **Rate limiting**: RAG build, encode, and other expensive endpoints are rate-limited per IP
- **Input validation**: Username length limits, request body size limits (50MB), text length limits
- **Timestamp-based merge**: Sync uses timestamps to determine newer data, preventing overwrite of fresher content
- **Sync mutex lock**: Prevents concurrent sync operations from causing data loss
- **Orphan record cleanup**: Sync automatically skips novel-associated data for deleted novels; deleting a novel cascades to RAG cache cleanup

---

## Notes

- **Backend is for LAN/local use only — do not expose to the public internet**. No password auth, SQLite not suitable for public concurrency. Exposing the backend risks API key theft, session hijacking, and data corruption. The frontend on GitHub Pages is safe — sensitive data (API keys) is stored only in the browser
- **mkcert's root certificate (`rootCA.pem`) is sensitive material**: it can be used to sign trusted certificates for any domain. After installing it on your family's / your own devices, delete the transfer records; never distribute it publicly
- BGE index for very long novels (5000+ chapters) may take 5-30 min; normal reading is unaffected during build
- Server model loading peaks at ~2GB RAM
- Simultaneous builds are queued (max 10 tasks)
- API keys stored only in browser IndexedDB, never uploaded to server
- Debug panel defaults to off, hidden on mobile

---

## Browser Support

| Browser | Status |
|---------|--------|
| Chrome / Edge 86+ | Full support (screen wake lock on Android, requires HTTPS) |
| Firefox 120+ | Folder import requires manual file selection |
| Safari 15+ | Basic functionality; **there is no "Import from Folder" on iPhone/iPad** (it can only upload a flattened pile, so the entry is hidden) — use the file picker; for connecting to the backend see the "iOS / iPadOS Connection Guide" |
| Mobile Chrome / Safari | Responsive layout; whether read-aloud survives the screen going off is covered in "Does it keep reading when the screen is off / locked?" |

---

## License

MIT License. 

---

## Text-to-Speech (TTS)

Two reading-aloud engines are available: the browser's built-in **Web Speech API** (no downloads, ready to use) and the project's **Kokoro offline engine** (sherpa-onnx 1.13.6 WASM, bilingual Chinese/English, selectable voices, fully offline).

### Web Speech (browser built-in)

Click the ▶ Read Aloud button in the top bar to start reading the current chapter aloud.

**Features:**

- **Paragraph highlight tracking**: The currently read paragraph is automatically highlighted and scrolled into view
- **Pre-queue seamless playback**: Adjacent paragraphs are pre-queued to eliminate pauses between segments
- **Short paragraph merging**: Adjacent short paragraphs are automatically merged for reading
- **Speed control**: 0.5x ~ 3.0x, popup selection, changes take effect immediately
- **Sleep timer**: 15/30/60/90 minute auto-stop. The rule is **the timer is cleared when it fires** — once it stops, that setting is gone and starting playback again begins a fresh run; pressing pause part way through does not erase the minutes already counted, and resuming continues the countdown
- **Auto-advance**: Automatically plays the next chapter when the current one finishes
- **Progress bar seeking**: Click the progress bar to jump to a specific paragraph
- **Mobile-friendly**: Playback bar and popup panels are optimized for mobile
- **Read-aloud errors are not silent**: the play bar keeps showing "Read aloud failed: …" (「朗读出错：…」) together with the reason the server gave — truncated on narrow screens, hover / long-press for the whole sentence — instead of relying on a toast that disappears after 5 seconds

> **Known limitation**: Android Edge's Web Speech API has a browser-level defect — `speak()` works, but `getVoices()` always returns an empty list, so **voice selection is unavailable** and only the system default voice can be used. In that case, switch to the Kokoro offline engine below.

### Does it keep reading when the screen is off / locked?

Short answer: **the app itself never pauses read-aloud because the page is hidden** (this has been evidenced in a real browser: freezing the page's main thread for 30 seconds, the audio clock outside the page kept running). When the system actually cuts the audio on a real phone depends on the engine — **those readings are still pending on-device verification**. What can be stated:

- **Screen wake lock**: read-aloud and auto-reading ask the system to keep the screen awake, so it doesn't dim on its own while nobody is touching it. Support: Android Chrome 84+, iOS Safari 16.4+, Firefox 126+, and **only over HTTPS** (or same-origin localhost). When the lock can't be acquired the app degrades silently and reading continues — that covers battery-saver mode being on, a plain-HTTP page, or an older browser.
- **The lock cannot stop the physical button**: if you press the power key yourself, the system locks anyway; all the app can do is keep the screen from going dark on its own.
- **Backgrounding / switching tabs**: the browser takes the wake lock away forcibly, and the app re-requests it when it comes back to the foreground. Whether audio continues during that window is up to the browser and the OS — the app **makes no guarantee** and there is no single behaviour worth writing down.
- **Want to know whether the lock was actually granted**: the on-device self-test ("真机自检") on a phone lists each lock's state one by one (never requested / never granted / granted then revoked), with the three failure reasons shown separately.
- **The silence when a chapter turns**: the Kokoro engine queues the first few paragraphs of the next chapter as soon as the current chapter reaches its last sentence, so with server inference you don't wait through a whole extra round; the residual very short gap is a known behaviour and stays as is. Web Speech is read by the browser itself, so no warm-ahead is involved.

### Kokoro engine (server inference & browser inference)

Based on the sherpa-onnx 1.13.6 Kokoro multi-lang v1.0 **fp32** model (53 voices; Chinese: 8 voices — female 晓北/晓妮/晓晓/晓伊, male 云健/云希/云夏/云扬). **Two inference modes** (switchable on the settings page):

| Mode | Where inference happens | Speed | Depends on |
|---|---|---|---|
| **Server inference** (recommended) | Python on the server (sherpa-onnx native multi-threading, 8 threads) | RTF≈0.6, ~2.5s for 18 characters — **you can listen while it synthesises** | Python + `pip install sherpa-onnx` on the server |
| **Browser inference** | WASM in the browser (offline) | RTF≈12, ~69s for 29 characters | the model (~380MB) downloaded once into the browser, fully offline afterwards |
| Web Speech | built into the browser | real time | no download; on some Android builds voices cannot be selected |

**Models download on demand:** the model (~350MB) is no longer fetched automatically when the backend starts — you **pick the corresponding inference mode on the settings page and click "Enable"** (「启用」) to download it: server inference downloads onto the server (once, shared by all users), browser inference downloads into the browser's IndexedDB (once per device). Nothing is downloaded while it stays disabled.

**Three-layer download pipeline:**

1. **Model source**: the WASM engine (including the trimmed espeak-ng-data) comes from the Gitee release `Kokoro_fp32_v1.0`; the model (Kokoro v1.0 fp32, ~310MB) is fetched from the same Gitee release as 7z volumes (fast in China), falling back automatically to the official GitHub tts-models release (with gh-proxy / gh.llkk.cc mirrors) if that fails
2. **Server cache** (`server/data/tts-cache/`): downloaded automatically when you enable server inference on the settings page (SSE progress); can also be triggered manually via /api/rag/tts/prepare
3. **Browser cache (IndexedDB)**: fetched automatically (authenticated, file by file) when you enable browser inference on the settings page — once only, then fully offline

> **⚠️ Important: do not use the int8 model**. Kokoro v1.0 int8 (`model.int8.onnx`, 114MB) produces **all-NaN audio** under sherpa-onnx 1.13.6 WASM (the generation and playback pipeline look healthy, but you hear nothing). Use the fp32 package (`model.onnx`, 310MB).

**Server inference deployment requirements:**

- Python 3.9+ on the server: `pip install sherpa-onnx` (~30MB, native multi-threaded inference)
- The model is downloaded to the server the first time you enable it on the settings page (~350MB, once only, then shared by all users)
- The backend must be able to reach Gitee (the CN-fast source) and GitHub (the official model source)

---

## FAQ

### npm install fails with better-sqlite3 compilation error

**Cause**: `better-sqlite3` is a native module. Node.js 24+ has no prebuilt binaries. This project requires Node.js 18-22 LTS.

**Solutions (pick one)**:

1. **Use nvm to install Node.js 22 LTS** (recommended)
   - Windows: Download and install [nvm-windows](https://github.com/coreybutler/nvm-windows/releases)
   - macOS/Linux: Run `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash`
   - After installing, restart terminal and run:
     ```bash
     nvm install 22       # Install Node 22 LTS
     nvm use 22           # Switch to Node 22
     ```

2. **Install Node.js 22 LTS directly** (without nvm)
   - Uninstall current Node.js
   - Download 22.x.x LTS from https://nodejs.org

### mkcert installation problems

**Install commands** (admin privileges required):

```bash
winget install FiloSottile.mkcert    # Windows
brew install mkcert                  # macOS
sudo apt install mkcert              # Linux
```

**"The requested package is already installed, no upgrades available" — but the `mkcert` command doesn't exist?**

Leftover winget registration (the install record is there, the executable is gone). Clean it up with **normal (non-admin) privileges**, then reinstall:

```bash
winget uninstall FiloSottile.mkcert   # run as a normal user; as admin it errors with "user scope cannot be uninstalled"
winget install FiloSottile.mkcert
```

**Command still not found after installing?** Close the terminal and open a new one (PATH reload), then try `mkcert --version`.

**`mkcert -install` fails?** It needs admin privileges: on Windows right-click PowerShell → "Run as administrator"; on macOS/Linux use `sudo`.

**`server/data/` only has cert.pem/key.pem, no rootCA.pem?** That's normal — the root certificate always lives in mkcert's CAROOT directory, not in the project. Run `mkcert -CAROOT` to see the location (Windows default `%LOCALAPPDATA%\mkcert`) and take `rootCA.pem` from there. The server copies the root certificate to `server/data/rootCA.pem` when it first generates a certificate; if it isn't there, copy it by hand.

### The page behaves strangely after a version upgrade (stale cache)

The frontend carries a PWA Service Worker cache. After the server updates, your browser may still be running the previously cached code (typical symptom: the console 404s on old paths that no longer exist).

**Fix**: hard refresh (Ctrl+Shift+R), or DevTools → Application → Storage → Clear site data. On iOS: Settings → Safari → Clear History and Website Data. The project also has two safety nets of its own: the SW clears outdated caches when it updates (`cleanupOutdatedCaches`), and a dialog appears when the frontend and backend versions disagree.

### Browser console shows mixed content warning

**Cause**: the GitHub Pages (HTTPS) frontend sends requests to an HTTP backend, which produces a yellow warning.

**Impact**: on desktop browsers this is only a warning — **requests are not blocked**, all features work normally. **iOS Safari blocks them outright** (there is no override), so you must switch to an HTTPS backend or same-origin mode — see the "iOS / iPadOS Connection Guide".

### Frontend cannot connect to backend

**Checklist**:
1. Is the backend running? (Terminal shows `[sync] http://0.0.0.0:5173`)
2. Do the protocol and port match? `http://` goes with `:5173`, `https://` with `:8443` (both ports listen at the same time)
3. **iOS devices**: the GitHub Pages frontend + HTTP backend combination is blocked by the platform — use same-origin mode or mkcert HTTPS
4. Lost HTTPS after switching Wi-Fi / IP? Restart the backend, which re-issues the certificate automatically (it checks for IP changes at startup; you only need to delete `server/data/cert.pem` and `key.pem` and restart if that re-issuing itself fails)
5. Are frontend and backend on the same LAN? Is the firewall letting 5173/8443 through?
6. The rootCA is installed on the phone but HTTPS still fails? Nine times out of ten the "Certificate Trust Settings" full-trust switch was missed (Settings → General → About → Certificate Trust Settings). To check: open `https://<computer-IP>:8443` directly in Mobile Safari — no warning (a lock icon) means the certificate is really working; note that in-app request failures do **not** pop a certificate prompt, so don't be fooled by "it didn't complain about anything"

### AI summaries or the map come back empty or error out

Check in this order — in most cases the connection isn't broken:

1. **First look at what is in the "Max output tokens" field.** Many providers today are reasoning models that spend that part of the budget on internal thinking first — set too small and you get no answer at all, which looks exactly like "this provider doesn't work". **The safest setting is to leave it empty** (each task asks for what it needs; the largest preset is 16,384). A number you type in is a shared ceiling: type 8,192 and the novel map, which needs 16,384, only gets 8,192, so it can stop half way.
2. **Read what the panel actually says instead of just "failed".** The panel shows the provider's original wording plus the raw response snippet:
   - "API returned an empty result… it sent back N characters of thinking" (「API 返回了空结果…回的是 N 字思考」) = the budget was eaten by thinking (the app already re-sent once with thinking disabled; it only reports this when that failed too);
   - the provider objecting to your `max_tokens` (a message carrying its own ceiling, e.g. `should be in [1, 65536]`) = no need to guess, the app shrinks one step and re-sends, then keeps using that number for the same provider during this session;
   - "频率过高 / Too Many Requests" = the quota window hasn't rolled over yet; that's an external limit, wait a bit and click again — the app will not waste a second send on it;
   - 401 / 402 = dead key or exhausted balance; also stops at one send instead of burning quota repeatedly.
3. **If the provider doesn't allow direct browser requests (CORS), the app switches to the server proxy automatically** — provided the backend is online. With the backend down, a failed direct request is reported as it is rather than retried silently.
4. **A typo in the model name, or a key without access, usually comes back as a 4xx** and the panel pastes that sentence. If the provider answered 200 with no content and left no evidence of "spent on thinking", the line reads 「可能原因：模型名称不存在或无权访问、请求参数不被支持」 — that is **the fallback wording when there is no evidence**, not a diagnosis; whenever evidence exists (thinking token count or thinking character count) it reports the number instead of making you guess.

### How to reinstall dependencies

If dependencies are corrupted or after switching Node versions:

```bash
# Windows CMD
rmdir /s /q node_modules
del package-lock.json
npm install

# macOS / Linux
rm -rf node_modules package-lock.json
npm install
```
