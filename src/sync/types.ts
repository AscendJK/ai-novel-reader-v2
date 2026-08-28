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
}
