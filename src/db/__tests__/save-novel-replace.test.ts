/**
 * 重新解析同一本书时的整本替换语义（批次 6 的 writeNovelOnce）
 *
 * 这一处是"上传/重传"落到本地库的最后一步，三个失败模式都不报错、只留数据形状不对：
 *   1. 新一次解析的章节变少时，旧章节没被清掉 → 目录里留幽灵章节；
 *   2. 分批写入的批次边界写错 → 长本小说后半本静默丢失；
 *   3. 元数据与章节不在同一个事务里 → 中途失败留下"有书没章"的半成品，界面是空目录。
 * 三条都能在真 IndexedDB 上直接验，所以这里不桩 Dexie。
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setCurrentUser, deleteUserDB, getUserDB } from "../database";
import { saveNovel, loadNovel, loadAllNovelMeta } from "../repositories";
import type { Novel } from "@/parsers/types";

const USER = "replace-user";

function novelWith(chapterCount: number, id = "book-1", contentOf?: (i: number) => string): Novel {
  const now = Date.now();
  return {
    id,
    title: "笑傲测试",
    author: "某作者",
    fileName: "f.txt",
    fileFormat: "txt",
    totalChars: chapterCount * 10,
    chapterCount,
    createdAt: now,
    updatedAt: now,
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: `${id}-ch-${i}`,
      novelId: id,
      index: i,
      title: `第${i + 1}章`,
      content: contentOf ? contentOf(i) : `第${i + 1}章正文`,
      startOffset: i * 10,
      endOffset: (i + 1) * 10,
    })),
  } as Novel;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sync-username", USER);
  setCurrentUser(USER);
});

afterEach(async () => {
  localStorage.clear();
  await deleteUserDB(USER);
});

describe("整本替换", () => {
  it("重新解析后章节变少时，多出来的旧章节必须被清掉", async () => {
    await saveNovel(novelWith(5));
    expect((await loadNovel("book-1"))!.chapters).toHaveLength(5);

    await saveNovel(novelWith(3));
    const after = await loadNovel("book-1");
    expect(after!.chapters.map((c) => c.title)).toEqual(["第1章", "第2章", "第3章"]);
    // 直接查表：不能只是 loadNovel 过滤掉了，库里就不该再有第4/5章
    const rows = await getUserDB().chapters.where("novelId").equals("book-1").toArray();
    expect(rows).toHaveLength(3);
  });

  it("章节 id 变了（重新切章）时旧 id 的行不能留下", async () => {
    await saveNovel(novelWith(2));
    const reCut = novelWith(2);
    reCut.chapters = reCut.chapters.map((c) => ({ ...c, id: `other-${c.index}`, title: `新第${c.index + 1}章` }));
    await saveNovel(reCut);
    const rows = await getUserDB().chapters.where("novelId").equals("book-1").toArray();
    expect(rows.map((r) => r.id).sort()).toEqual(["other-0", "other-1"]);
  });

  it("600 章的书必须整本落库（分批写入的边界就是这一类 bug 的位置）", async () => {
    await saveNovel(novelWith(600, "long-1", (i) => `第${i + 1}章正文`));
    const loaded = await loadNovel("long-1");
    expect(loaded!.chapters).toHaveLength(600);
    expect(loaded!.chapters[599].content).toBe("第600章正文");
    expect(loaded!.chapters[500].title).toBe("第501章");
  });

  it("章节写失败时整本回滚——不许留下「有书没章」的半成品", async () => {
    const broken = novelWith(3);
    // 结构化克隆不了的字段：bulkPut 会抛 DataCloneError，模拟写到一半失败
    (broken.chapters[2] as unknown as { content: unknown }).content = () => "写不进去";
    await expect(saveNovel(broken)).rejects.toBeTruthy();
    expect(await loadNovel("book-1")).toBeNull();
    expect((await loadAllNovelMeta()).find((n) => n.id === "book-1")).toBeUndefined();
  });
});
