import { sharedDB, getUserDB } from "@/db/database";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export async function exportNovelAsJSON(novelId: string) {
  const udb = getUserDB();
  const novel = await udb.novels.get(novelId);
  if (!novel) return;
  const chapters = await udb.chapters.where("novelId").equals(novelId).sortBy("index");
  const summaries = await udb.summaries.where("novelId").equals(novelId).toArray();
  const notes = await udb.notes.where("novelId").equals(novelId).toArray();

  const data = { novel, chapters, summaries, notes, exportedAt: Date.now() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  download(blob, `${novel.title}-${timestamp()}.json`);
}

export async function exportNovelAsTXT(novelId: string) {
  const udb = getUserDB();
  const novel = await udb.novels.get(novelId);
  if (!novel) return;
  const chapters = await udb.chapters.where("novelId").equals(novelId).sortBy("index");

  let text = `${novel.title}\n`;
  if (novel.author) text += `作者: ${novel.author}\n`;
  text += `\n${"=".repeat(40)}\n\n`;

  for (const ch of chapters) {
    text += `${ch.title}\n\n${ch.content}\n\n`;
  }

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  download(blob, `${novel.title}-${timestamp()}.txt`);
}

export async function exportAllAsJSON() {
  const udb = getUserDB();
  const novels = await udb.novels.toArray();
  const chapters = await udb.chapters.toArray();
  const summaries = await udb.summaries.toArray();
  const notes = await udb.notes.toArray();
  // Exclude sensitive API settings
  const settings = (await sharedDB.settings.toArray()).filter(
    (s) => !s.key.startsWith("api-providers") && !s.key.startsWith("api-active-provider")
  );

  const data = { novels, chapters, summaries, notes, settings, exportedAt: Date.now(), version: 1 };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  download(blob, `小说阅读器备份-${timestamp()}.json`);
}

interface ImportData {
  novels?: Array<{ id: string; title: string; [key: string]: unknown }>;
  chapters?: Array<{ id: string; novelId: string; [key: string]: unknown }>;
  summaries?: Array<{ id: string; novelId: string; [key: string]: unknown }>;
  notes?: Array<{ id: string; novelId: string; [key: string]: unknown }>;
  settings?: Array<{ key: string; value: unknown }>;
  exportedAt?: number;
  version?: number;
}

export async function importFromJSON(file: File): Promise<{ novels: number; chapters: number; summaries: number; notes: number }> {
  const udb = getUserDB();
  const text = await file.text();
  let data: ImportData;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("导入文件格式无效，请确认是正确的 JSON 备份文件");
  }

  let novelCount = 0, chapterCount = 0, summaryCount = 0, noteCount = 0;

  await udb.transaction("rw", udb.novels, udb.chapters, udb.summaries, udb.notes, async () => {
    if (data.novels?.length) {
      for (const n of data.novels) { await udb.novels.put(n); novelCount++; }
    }
    if (data.chapters?.length) {
      for (const ch of data.chapters) { await udb.chapters.put(ch); chapterCount++; }
    }
    if (data.summaries?.length) {
      for (const s of data.summaries) { await udb.summaries.put({ ...s, updatedAt: s.updatedAt || Date.now() }); summaryCount++; }
    }
    if (data.notes?.length) {
      for (const n of data.notes) { await udb.notes.put({ ...n, updatedAt: n.updatedAt || Date.now() }); noteCount++; }
    }
  });
  // Settings go to shared DB
  if (data.settings?.length) {
    for (const s of data.settings) { await sharedDB.settings.put(s); }
  }

  return { novels: novelCount, chapters: chapterCount, summaries: summaryCount, notes: noteCount };
}
