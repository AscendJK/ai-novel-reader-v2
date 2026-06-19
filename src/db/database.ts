import Dexie, { type Table } from "dexie";

// ── Record interfaces ──

export interface NovelRecord {
  id: string;
  title: string;
  author?: string;
  fileName: string;
  fileFormat: "txt" | "epub";
  totalChars: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChapterRecord {
  id: string;
  novelId: string;
  index: number;
  title: string;
  content: string;
  startOffset: number;
  endOffset: number;
}

export interface SummaryRecord {
  id: string;
  chapterId: string;
  chapterTitle: string;
  novelId: string;
  content: string;
  tokensUsed: number;
  createdAt: number;
  updatedAt: number;
  type: string;
  usedFallback?: boolean;
  deleted?: number;
}

export interface SettingsRecord {
  key: string;
  value: unknown;
}

export interface NoteRecord {
  id: string;
  novelId: string;
  chapterId: string;
  chapterTitle: string;
  content: string;
  source: "user" | "ai";
  sourceLabel: string;
  createdAt: number;
  updatedAt: number;
  deleted?: number;
}

export interface RAGCacheRecord {
  id: string;           // composite key: "${novelId}-${engine}"
  novelId: string;      // raw novel UUID
  engine: string;
  vectorsBuffer: ArrayBuffer;  // Float32Array 二进制数据
  chunks: { id: string; content: string; chapterIndex?: number }[];
  dim: number;
  chunkCount: number;   // chunk 数量
  createdAt: number;
  lastAccessed?: number;  // 最后访问时间（用于智能淘汰）
  accessCount?: number;   // 访问次数（用于智能淘汰）
  extraData?: string;     // JSON 序列化的附加数据（TF-IDF 存 idfMap）
}

export interface MapRecord {
  id: string;           // novelId
  novelId: string;
  data: unknown;        // MapData JSON
  createdAt: number;
  updatedAt: number;
  deleted?: number;
}

export interface GraphRecord {
  id: string;           // novelId
  novelId: string;
  data: unknown;        // GraphData JSON
  createdAt: number;
  updatedAt: number;
  deleted?: number;
}

// ── Shared database (settings + ragCache, not per-user) ──

class SharedDB extends Dexie {
  settings!: Table<SettingsRecord, string>;
  ragCache!: Table<RAGCacheRecord, string>;

  constructor() {
    super("ai-novel-reader-shared");
    this.version(1).stores({
      settings: "key",
      ragCache: "id, novelId, engine, createdAt",
    });
    // 添加 lastAccessed 和 accessCount 索引
    this.version(2).stores({
      settings: "key",
      ragCache: "id, novelId, engine, createdAt, lastAccessed, accessCount",
    });
  }
}

// ── User database (novels, chapters, summaries, notes, maps per-user) ──

class UserDB extends Dexie {
  novels!: Table<NovelRecord, string>;
  chapters!: Table<ChapterRecord, string>;
  summaries!: Table<SummaryRecord, string>;
  notes!: Table<NoteRecord, string>;
  maps!: Table<MapRecord, string>;
  graphs!: Table<GraphRecord, string>;

  constructor(username: string) {
    super(`ai-novel-reader-${username}`);
    this.version(1).stores({
      novels: "id, createdAt",
      chapters: "id, novelId, index",
      summaries: "id, novelId, chapterId, type, updatedAt, deleted, [novelId+chapterId+type]",
      notes: "id, novelId, chapterId, source, createdAt, updatedAt, deleted",
    });
    // 添加复合索引以优化查询性能
    this.version(2).stores({
      novels: "id, createdAt",
      chapters: "id, novelId, index",
      summaries: "id, novelId, chapterId, type, updatedAt, deleted, [novelId+chapterId+type], [novelId+type]",
      notes: "id, novelId, chapterId, source, createdAt, updatedAt, deleted",
    });
    // 添加 maps 表
    this.version(3).stores({
      novels: "id, createdAt",
      chapters: "id, novelId, index",
      summaries: "id, novelId, chapterId, type, updatedAt, deleted, [novelId+chapterId+type], [novelId+type]",
      notes: "id, novelId, chapterId, source, createdAt, updatedAt, deleted",
      maps: "id, novelId, updatedAt, deleted",
    });
    // 添加 graphs 表（人物图谱，从 sharedDB.settings 迁移至此实现用户隔离）
    this.version(4).stores({
      novels: "id, createdAt",
      chapters: "id, novelId, index",
      summaries: "id, novelId, chapterId, type, updatedAt, deleted, [novelId+chapterId+type], [novelId+type]",
      notes: "id, novelId, chapterId, source, createdAt, updatedAt, deleted",
      maps: "id, novelId, updatedAt, deleted",
      graphs: "id, novelId, updatedAt, deleted",
    });
    // 添加复合索引优化 hasMoreChanges 和 cleanupDeletedRecords 查询
    this.version(5).stores({
      novels: "id, createdAt",
      chapters: "id, novelId, index",
      summaries: "id, novelId, chapterId, type, updatedAt, deleted, [novelId+chapterId+type], [novelId+type]",
      notes: "id, novelId, chapterId, source, createdAt, updatedAt, deleted",
      maps: "id, novelId, updatedAt, deleted, [deleted+updatedAt]",
      graphs: "id, novelId, updatedAt, deleted, [deleted+updatedAt]",
    });
  }
}

// ── Exports ──

/** Shared database — settings and ragCache, always available */
export const sharedDB = new SharedDB();

/** Current user's database — set via setCurrentUser() after login */
let _userDB: UserDB | null = null;

/** Switch to a user's database */
export function setCurrentUser(username: string) {
  const oldDB = _userDB;
  // 创建新数据库实例
  _userDB = new UserDB(username);
  // 关闭旧数据库（在新数据库准备好之后）
  if (oldDB) {
    try {
      oldDB.close();
    } catch { /* ignore close errors */ }
  }
}

/** Get the current user's database. Auto-initializes from localStorage if needed. */
export function getUserDB(): UserDB {
  if (!_userDB) {
    const username = localStorage.getItem("sync-username");
    if (username) {
      setCurrentUser(username);
    } else {
      throw new Error("未登录，无法访问用户数据库");
    }
  }
  return _userDB!;
}

/** Delete a user's entire database */
export async function deleteUserDB(username: string) {
  const dbName = `ai-novel-reader-${username}`;
  // Close the connection if this is the current user's database
  if (_userDB && _userDB.name === dbName) {
    _userDB.close();
    _userDB = null;
  }
  await Dexie.delete(dbName);
}
