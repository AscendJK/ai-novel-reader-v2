# AI Novel Reader

A browser-based AI-powered novel reading tool. Upload TXT/EPUB files, configure any LLM API, and get chapter summaries, character relationship graphs, plot timelines, AI Q&A, and more. Built-in user system with cross-device sync.

[中文](README.md)

## Quick Start

The project uses a **front-end/back-end separated architecture**: the frontend is deployed on GitHub Pages, and the backend runs on your local machine.

### Frontend (GitHub Pages)

The frontend is deployed on GitHub Pages. **No installation required** — just visit:

**https://ascendjk.github.io/ai-novel-reader-v2/**

You can use it without configuring a server (offline mode). Configure a server to enable sync.

### Backend (Local Deployment)

The backend provides RAG building, data sync, book library management, and other services, running on your own machine.

**Prerequisites**:
- [Node.js](https://nodejs.org) v18~22 LTS (22 recommended)

> **Node.js 24+ users**: `better-sqlite3` lacks prebuilt binaries for Node 24, requiring Python 3.x and C++ build tools. We recommend **Node.js 22 LTS**.

**Option 1: Download backend package (Recommended)**

Download `ai-novel-reader-backend-v2.x.x.zip` (~36 KB) from [Releases](https://github.com/AscendJK/ai-novel-reader-v2/releases), then:

- **Windows**: Double-click `start.bat`
- **macOS / Linux**: `chmod +x start.sh && ./start.sh`

The script will auto-install dependencies (server-side only, no frontend build) and start the backend. Models will be downloaded from the mirror on first index build (requires network).

**Option 2: Clone the entire repo**

```bash
git clone https://github.com/AscendJK/ai-novel-reader-v2.git
cd ai-novel-reader-v2
```

- **Windows**: Double-click `start.bat`
- **macOS / Linux**: `chmod +x start.sh && ./start.sh`

The script will auto-install dependencies, build the frontend, and start the server.

The terminal will display:
```
[sync] http://0.0.0.0:5173 (api-only)
```

**Connect the frontend**:

1. Open the frontend page
2. Enter the backend server address on the login screen (e.g., `http://192.168.1.100:5173`)
3. Click "Save & Connect" — "Connected" means success

> **How to find the server IP**: Windows: run `ipconfig`, macOS/Linux: run `ifconfig` or `ip addr`, look for the LAN IPv4 address.

### Development Mode (Optional)

For local frontend development, start frontend and backend separately:

```bash
# Terminal 1: Start backend (use port 3001 to avoid conflict with Vite)
PORT=3001 npm run server

# Terminal 2: Start frontend dev server
npm run dev
```

Dev server runs at `http://localhost:5173`, API requests are automatically proxied to the backend at `localhost:3001`.

---

## HTTPS & Certificates (Optional)

**The project works perfectly without mkcert.** The backend runs in HTTP mode by default. When the frontend (GitHub Pages, HTTPS) sends requests to the backend (HTTP), the browser console shows a yellow mixed content warning, but **requests are not blocked** — all features work normally.

Installing mkcert only eliminates this warning; it is not required.

### Frontend

GitHub Pages provides HTTPS automatically. No extra configuration needed.

### Backend

The backend listens on HTTP (port 5173) by default. If [mkcert](https://github.com/FiloSottile/mkcert) is installed, the server will automatically start an additional HTTPS listener (port 8443), eliminating the browser's mixed content warning.

**Install mkcert** (optional):

```bash
# Windows (winget) - requires admin privileges
winget install mkcert

# macOS
brew install mkcert

# Linux
sudo apt install mkcert
```

Initialize after installation:

```bash
mkcert -install    # Install local CA (only needed once, requires admin privileges)
```

**Trust certificate on LAN devices**:

If using HTTPS to access the backend, other devices need to install the CA root certificate:

```bash
mkcert -CAROOT     # Get CA root certificate path
```

Send `rootCA.pem` to other devices and install:
- **Windows**: Double-click → Install certificate → Trusted Root Certification Authorities
- **macOS**: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain rootCA.pem`
- **Android**: Settings → Security → Encryption & credentials → Install certificate → CA certificate
- **iOS**: Settings → General → Profiles → Install → Settings → General → About → Certificate Trust Settings → Enable

| Access method | Without mkcert | With mkcert |
|--------------|---------------|-------------|
| `http://LAN-IP:5173` frontend + backend | ✅ Works | ✅ Works |
| `https://ascendjk.github.io` frontend + HTTP backend | ✅ Works (yellow warning in console) | ✅ Works (no warning) |
| `https://ascendjk.github.io` frontend + HTTPS backend | — | ✅ Works (no warning) |

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
2. **Configure server address** (optional): Click "Configure" to enter the backend address (e.g., `http://192.168.1.100:5173`). Without it, the app runs in offline mode

> Data is **browser-first** — the server is only for backup and cross-device sync. When the server is unreachable, "Create New" works normally as a local account. "Join Existing" requires the server to be online to fetch data.
>
> The same username on different devices operates independently. On first sync, if the server already has the same username, a conflict prompt appears — the user can rename or merge data.
>
> When switching users, if local data exists, the user is asked whether to keep or discard it.

### 2. Configure AI

Settings → choose provider (OpenAI, Anthropic, DeepSeek, or up to 5 custom OpenAI-compatible APIs) → enter API key and model name.

- API keys are stored only in your browser's IndexedDB
- API settings are isolated per user — different users on the same browser don't interfere
- Settings survive logout, user switching, and browser restarts
- API requests go directly from the browser to the provider. Some providers (e.g., Anthropic) may require the server proxy due to CORS restrictions
- Supports automatic token limit matching for 40+ common models

### 3. Upload Novels

Drag TXT/EPUB files onto the bookshelf, or use "Import from Folder" for batch upload. Supports GBK/Big5/UTF-8 encoding detection and smart chapter recognition.

- Novels are saved to local IndexedDB first, then synced to the server when available
- Novels work locally even when the server is unreachable; auto-uploaded when the server recovers
- Uploaded novels are automatically stored in the server library and visible to all users

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
- Aa button adjusts reading mode, font size, weight, line height, paragraph spacing, and font family (system default / serif / monospace)
- Dark / light mode toggle
- Mobile-responsive, auto-switches to single page mode
- Keyboard shortcut: `Shift + ?` to view all shortcuts

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
Backend: Local server (Express + better-sqlite3)
├─ Front-back separation: frontend connects to backend via user-configured server address
├─ Multi-agent engine: summary / characters / timeline / graph / map
├─ Multi-engine semantic retrieval: BGE / E5 / MiniLM / GTE ONNX models (Worker Thread encoding)
├─ d3-force character graph (mouse wheel + pinch-to-zoom on mobile)
├─ SVG novel map (geographic locations, faction distribution, drag/zoom, PNG export)
├─ Three reading modes: scroll (infinite continuous) / single page / double page book effect
├─ Smart chapter lazy loading (current ±10 chapters, load on demand, reduced memory usage)
├─ RAG vector binary transfer (Float32Array direct transfer, zero-copy loading)
├─ IndexedDB browser cache + SQLite server persistence
├─ PWA Service Worker offline caching
├─ Username system + Session Token auth + Server-side centralized sync
├─ Three-tier RAG cache: Memory LRU (100MB) → IndexedDB (100-500MB) → Server SQLite
├─ Periodic WAL checkpoint + automatic database backup (24h)
└─ Unit test coverage: 117 test cases (Vitest + Testing Library)
```

---

## Design Principles

- **Browser-first data**: Reading, notes, summaries, settings, and API keys all live in local IndexedDB
- **Server for RAG building and backup only**: Most features work when the server is unreachable
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
- BGE index for very long novels (5000+ chapters) may take 5-30 min; normal reading is unaffected during build
- Server model loading peaks at ~2GB RAM
- Simultaneous builds are queued (max 10 tasks)
- API keys stored only in browser IndexedDB, never uploaded to server
- Debug panel defaults to off, hidden on mobile

---

## Browser Support

| Browser | Status |
|---------|--------|
| Chrome / Edge 86+ | Full support |
| Firefox 120+ | Folder import requires manual file selection |
| Safari 15+ | Basic functionality |
| Mobile Chrome / Safari | Responsive layout |

---

## License

MIT License. Built-in models:
- **BGE Small ZH v1.5** — from BAAI (Beijing Academy of Artificial Intelligence), MIT licensed
- **GTE Small** — from Alibaba DAMO Academy, Apache 2.0 licensed

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

### mkcert installation fails

**Cause**: Requires admin privileges.

**Solution**:
- Windows: Run terminal as Administrator (right-click PowerShell → Run as administrator)
- macOS/Linux: Use `sudo`

### Browser console shows mixed content warning

**Cause**: GitHub Pages (HTTPS) frontend sends requests to HTTP backend, triggering a yellow warning.

**Impact**: Warning only — **requests are not blocked**, all features work normally.

**To eliminate warning**: Install mkcert and the server will automatically enable HTTPS. Not required for normal use.

### Frontend cannot connect to backend

**Checklist**:
1. Is the backend running? (Terminal shows `[sync] http://0.0.0.0:5173`)
2. Is the server address correct? (Include protocol and port, e.g., `http://192.168.1.100:5173`)
3. Are the frontend and backend on the same LAN?
4. Is port 5173 allowed through the firewall?
5. The mixed content yellow warning in the console does not affect connectivity — ignore it

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
