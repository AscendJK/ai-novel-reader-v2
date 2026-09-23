// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * 导入这一关的守卫（`useFileParser.parseFile`）。
 *
 * 为什么单独钉：这只 hook 是"用户把一本书交给这个应用"的第一道门，里面有四条已经修过的语义
 * 全靠注释在传话——100MB 拒 / 10MB 提示（`:49-54`）、手动编码要一路透传到 `parseTxt`
 * （round 2 R-57，`:62-65`）、本地存不下时**中止**导入以免留下打不开的"幽灵书"（`:79-91`）、
 * 上传失败不许把书丢掉（`:146-149`）。这些此前一条判据都没有（覆盖地板第 2 档）。
 */
vi.mock("@/parsers/txt", () => ({ parseTxt: vi.fn() }));
vi.mock("@/parsers/epub", () => ({ parseEpub: vi.fn() }));
vi.mock("@/db/repositories", () => ({ saveNovel: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota-guard", () => ({ isQuotaError: vi.fn(() => false) }));
vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/toast-store", () => ({ showToast: vi.fn() }));
vi.mock("@/lib/broadcast", () => ({ broadcast: { send: vi.fn(), on: vi.fn(), close: vi.fn() } }));
vi.mock("@/rag/index", () => ({ clearCache: vi.fn() }));

const addNovel = vi.fn();
vi.mock("@/stores/novel-store", () => ({
  useNovelStore: (selector: (s: { addNovel: typeof addNovel }) => unknown) => selector({ addNovel }),
}));

import { useFileParser } from "@/hooks/useFileParser";
import { parseTxt } from "@/parsers/txt";
import { parseEpub } from "@/parsers/epub";
import { saveNovel } from "@/db/repositories";
import { isQuotaError } from "@/lib/quota-guard";
import { apiFetch } from "@/lib/api-client";
import { showToast } from "@/lib/toast-store";
import { broadcast } from "@/lib/broadcast";

const parsed = {
  title: "测试书",
  author: "作者",
  chapters: [
    { title: "第一章", content: "第一章\n" + "正文。".repeat(60) },
    { title: "第二章", content: "第二章\n" + "正文。".repeat(60) },
  ],
  totalChars: 300,
};

/** 一只指定字节数的 File（内容不重要，守卫看的是 size 与扩展名） */
function fileOf(name: string, size: number): File {
  const f = new File([new Uint8Array(0)], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseTxt).mockResolvedValue(parsed as never);
  vi.mocked(parseEpub).mockResolvedValue(parsed as never);
  vi.mocked(saveNovel).mockResolvedValue(undefined as never);
  vi.mocked(isQuotaError).mockReturnValue(false);
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ novelId: "srv-1" }) } as never);
});

const MB = 1024 * 1024;

describe("进门前的三道守卫", () => {
  it("超过 100MB 直接拒：不去解析、不上架，文案把两个数都写出来", async () => {
    const { result } = renderHook(() => useFileParser());
    let returned: unknown;
    await act(async () => {
      returned = await result.current.parseFile(fileOf("巨大.txt", 101 * MB));
    });
    expect(returned).toBeNull();
    expect(parseTxt).not.toHaveBeenCalled();
    expect(saveNovel).not.toHaveBeenCalled();
    expect(addNovel).not.toHaveBeenCalled();
    expect(result.current.error).toContain("文件太大");
    expect(result.current.error).toContain("101.0 MB");
    expect(result.current.error).toContain("100.0 MB");
  });

  it("10~100MB 只是提示，导入照走（不许把警告做成拦路）", async () => {
    const { result } = renderHook(() => useFileParser());
    await act(async () => {
      await result.current.parseFile(fileOf("挺大.txt", 12 * MB));
    });
    expect(result.current.warning).toContain("文件较大");
    expect(result.current.error).toBeNull();
    expect(addNovel).toHaveBeenCalledTimes(1);
  });

  it(".pdf 要说清支持什么，而不是默默按 TXT 解", async () => {
    const { result } = renderHook(() => useFileParser());
    await act(async () => {
      await result.current.parseFile(fileOf("说明.pdf", MB));
    });
    expect(result.current.error).toContain("当前支持 .txt 和 .epub 格式");
    expect(parseTxt).not.toHaveBeenCalled();
    expect(parseEpub).not.toHaveBeenCalled();
  });
});

describe("解析与落库", () => {
  it("手动指定的编码必须一路传到 parseTxt（这是自动识别失败时用户唯一的纠错入口）", async () => {
    const { result } = renderHook(() => useFileParser());
    await act(async () => {
      await result.current.parseFile(fileOf("繁体.txt", MB), { encoding: "big5" });
    });
    expect(vi.mocked(parseTxt).mock.calls[0][1]).toEqual({ encoding: "big5" });
  });

  it("留空或写 auto 时不许把空设置当成编码传下去", async () => {
    const { result } = renderHook(() => useFileParser());
    await act(async () => {
      await result.current.parseFile(fileOf("a.txt", MB), { encoding: "auto" });
      await result.current.parseFile(fileOf("b.txt", MB), { encoding: "   " });
      await result.current.parseFile(fileOf("c.txt", MB));
    });
    expect(vi.mocked(parseTxt).mock.calls.map((c) => c[1])).toEqual([undefined, undefined, undefined]);
  });

  it("EPUB 走 EPUB 解析器，书的来源格式要记对", async () => {
    const { result } = renderHook(() => useFileParser());
    let novel: { fileFormat?: string } | null = null;
    await act(async () => {
      novel = await result.current.parseFile(fileOf("书.epub", MB));
    });
    expect(parseEpub).toHaveBeenCalledTimes(1);
    expect(parseTxt).not.toHaveBeenCalled();
    expect(novel).not.toBeNull();
    expect(addNovel.mock.calls[0][0].fileFormat).toBe("epub");
  });

  it("本地存不下时中止导入：不进书架、不传服务器，文案指向存储管理", async () => {
    vi.mocked(saveNovel).mockRejectedValue(new Error("QuotaExceededError"));
    vi.mocked(isQuotaError).mockReturnValue(true);
    const { result } = renderHook(() => useFileParser());
    await act(async () => {
      await result.current.parseFile(fileOf("大书.txt", MB));
    });
    expect(addNovel).not.toHaveBeenCalled();
    // 幽灵书那半句：本地都没有，就不该把目录与章节推给服务器
    expect(apiFetch).not.toHaveBeenCalled();
    expect(result.current.error).toContain("浏览器存储空间不足");
    expect(result.current.error).toContain("存储管理");
  });

  it("保存失败但不是配额时也要中止，且把原话带出来", async () => {
    vi.mocked(saveNovel).mockRejectedValue(new Error("IndexedDB 被别的标签页锁住"));
    const { result } = renderHook(() => useFileParser());
    await act(async () => {
      await result.current.parseFile(fileOf("锁住.txt", MB));
    });
    expect(addNovel).not.toHaveBeenCalled();
    expect(result.current.error).toContain("IndexedDB 被别的标签页锁住");
  });

  it("上传服务器失败不许把书丢掉：本地照上架，并告诉用户为什么", async () => {
    // 重试之间有 2 秒真等待（`useFileParser.ts:120`），这一发因此慢一拍；
    // 不用假时钟是因为这里要判的是"重试跑完之后"的状态，拨钟会把 setTimeout 的语义整个换掉
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as never);
    const { result } = renderHook(() => useFileParser());
    await act(async () => {
      await result.current.parseFile(fileOf("离线.txt", MB));
    });
    expect(addNovel).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("已保存到本地"), "warn");
    expect(result.current.error).toBeNull();
  });

  it("成功那一趟要喊其他标签页重读书架", async () => {
    const { result } = renderHook(() => useFileParser());
    let novel: { id?: string } | null = null;
    await act(async () => {
      novel = await result.current.parseFile(fileOf("新书.txt", MB));
    });
    expect(result.current.progress).toBe(100);
    expect(broadcast.send).toHaveBeenCalledWith("data-changed", { kind: "novel-added", id: novel?.id });
    expect(result.current.isParsing).toBe(false);
  });
});
