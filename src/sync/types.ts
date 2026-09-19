import type { SummaryItem } from "@/stores/summary-store";
import type { NoteItem, MapRecord, GraphRecord } from "@/db/repositories";

export interface SyncData {
  summaries: SummaryItem[];
  notes: NoteItem[];
  maps: MapRecord[];
  graphs: GraphRecord[];
  settings: Record<string, unknown>;
  progress: {
    readingPositions: Record<string, { chapterId: string; chapterIndex: number; scrollTop?: number; updatedAt?: number }>;
    lastOpened: Record<string, number>;
  };
  joinedNovelIds?: string[];
}

export interface PushPayload {
  username: string;
  clientId: string;
  changes: Partial<SyncData>;
  lastSyncTime: number;
}

export interface RegisterResult {
  clientId: string;
  token: string;
  activeCount: number;
  data: (SyncData & { username: string; lastSyncAt: number }) | null;
  isNew: boolean;
}

export interface HeartbeatResult {
  activeCount: number;
}

export interface PushResult {
  merged: boolean;
  data: SyncData & { username: string; lastSyncAt: number };
  /** 服务器跳过入库的孤儿数据所属的 novelId（小说尚未上传到服务器），前端应补传后重试 */
  orphanedNovelIds?: string[];
  /** 服务器判为坏载荷而丢弃的记录数（缺 id/novelId 或 upsert 抛错）。>0 就要报警：静默丢数据最难查 */
  skippedRecords?: number;
}
