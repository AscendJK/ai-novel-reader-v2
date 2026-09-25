import { describe, it, expect } from "vitest";
import JSZip from "jszip";

/**
 * EPUB 解析器。
 *
 * 为什么单独钉：`epub.ts` 头上写着三条**已经修过的**病因（OCF 属性顺序、href 百分号编码、
 * zip bomb 上限），而这三条一条判据都没有——浏览器层只有一条 `b-import` 灌了本最小 EPUB
 * 走通上架（`e2e/pages/shelf.ts:55` 那个 fixture），守卫与顺序全没人碰过。覆盖地板第 2 档
 * 量出来的就是这种形状：代码里留着"上次这里丢过章节"的注释，用例却一个没有。
 */
import { parseEpub } from "@/parsers/epub";

/** 每章正文都要过 `epub.ts:136` 那道 50 字门槛，不然会被当目录页/插图页丢掉 */
const body = (marker: string) =>
  `<html><head><title>略</title><style>p{color:red}</style><script>var x=1;</script></head><body><p>${marker}</p><p>${"正文一段。".repeat(14)}</p></body></html>`;

function opf(items: string[], spine: string[], titleXml = "<dc:title>山海志</dc:title>") {
  return `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<metadata><dc:identifier id="id">urn:uuid:1</dc:identifier>${titleXml}<dc:creator>某作者</dc:creator></metadata>
<manifest>${items.join("")}</manifest>
<spine>${spine.map((id) => `<itemref idref="${id}"/>`).join("")}</spine>
</package>`;
}

const CONTAINER = `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

/** 组一只真 zip：`entries` 里的 key 就是 zip 内的路径 */
async function epubFile(entries: Record<string, string | null>, name = "山海志.epub"): Promise<File> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  for (const [p, content] of Object.entries(entries)) {
    if (content === null) continue;
    zip.file(p, content);
  }
  // 用 arraybuffer 而不是 uint8array：后者在这个 TS/lib 组合下不是合法的 BlobPart
  // （`Uint8Array<ArrayBufferLike>` 里的 SharedArrayBuffer 分支），tsc 会拦住
  const buffer = await zip.generateAsync({ type: "arraybuffer" });
  return new File([buffer], name);
}

const twoChapters = () =>
  ({
    "META-INF/container.xml": CONTAINER,
    "OEBPS/content.opf": opf(
      [
        '<item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>',
      ],
      ["c1", "c2"],
    ),
    "OEBPS/chap1.xhtml": body("风起于青萍之末"),
    "OEBPS/chap2.xhtml": body("潮落于江天之上"),
  }) as Record<string, string>;

describe("parseEpub：结构与顺序", () => {
  it("没有可识别的章节标题时按 spine 分章，顺序就是 spine 的顺序", async () => {
    const r = await parseEpub(await epubFile(twoChapters()));
    expect(r.title).toBe("山海志");
    expect(r.author).toBe("某作者");
    expect(r.chapters.map((c) => c.title)).toEqual(["第1部分", "第2部分"]);
    expect(r.chapters[0].content).toContain("风起");
    expect(r.chapters[1].content).toContain("潮落");
  });
  it("spine 写反了就必须读反（章节顺序不靠文件名猜）", async () => {
    const e = twoChapters();
    e["OEBPS/content.opf"] = opf(
      [
        '<item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>',
      ],
      ["c2", "c1"],
    );
    const r = await parseEpub(await epubFile(e));
    expect(r.chapters[0].content).toContain("潮落");
    expect(r.chapters[1].content).toContain("风起");
  });

  it("href 写在 id 前面也不许丢章（OCF 不约束属性顺序，逐 <item> 提取才是对的）", async () => {
    const e = twoChapters();
    e["OEBPS/content.opf"] = opf(
      [
        '<item href="chap1.xhtml" media-type="application/xhtml+xml" id="c1"/>',
        '<item href="chap2.xhtml" media-type="application/xhtml+xml" id="c2"/>',
      ],
      ["c1", "c2"],
    );
    const r = await parseEpub(await epubFile(e));
    expect(r.chapters).toHaveLength(2);
    expect(r.chapters[1].content).toContain("潮落");
  });

  it("href 是百分号编码的中文文件名时照样取到内容（不解码就静默少章）", async () => {
    const e = twoChapters();
    e["OEBPS/第一章.xhtml"] = e["OEBPS/chap1.xhtml"];
    delete e["OEBPS/chap1.xhtml"];
    e["OEBPS/content.opf"] = opf(
      [
        `<item id="c1" href="${encodeURIComponent("第一章.xhtml")}" media-type="application/xhtml+xml"/>`,
        '<item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>',
      ],
      ["c1", "c2"],
    );
    const r = await parseEpub(await epubFile(e));
    expect(r.chapters).toHaveLength(2);
    expect(r.chapters[0].content).toContain("风起");
  });

  it("图片与字体不进正文；短于 50 字的 spine 项（扉页/目录页）不算一章", async () => {
    const e = twoChapters();
    e["OEBPS/cover.xhtml"] = "<html><body><p>封面</p></body></html>"; // 太短，该被门槛挡住
    e["OEBPS/cover.png"] = "假图片字节";
    e["OEBPS/content.opf"] = opf(
      [
        '<item id="cv" href="cover.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="img" href="cover.png" media-type="image/png"/>',
        '<item id="fnt" href="font.ttf" media-type="application/font-sfnt"/>',
        '<item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>',
      ],
      ["cv", "img", "fnt", "c1", "c2"],
    );
    const r = await parseEpub(await epubFile(e));
    expect(r.chapters).toHaveLength(2);
    expect(r.chapters.map((c) => c.content).join("")).not.toContain("封面");
  });

  it("<head>/<style>/<script> 与实体都要处理干净", async () => {
    const e = twoChapters();
    e["OEBPS/chap1.xhtml"] =
      "<html><head><title>标题</title></head><body><p>风起&nbsp;于&nbsp;青萍之末</p><p>他说——&ldquo;好&rdquo;，然后离开——这是破折号 &hellip; 省略</p><p>" +
      "正文一段。".repeat(14) +
      "</p><script>var 危险 = 1;</script></body></html>";
    const r = await parseEpub(await epubFile(e));
    expect(r.chapters[0].content).toContain("风起 于 青萍之末");
    // 现状如实钉：`&ldquo;/&rdquo;` 被压成直引号（`epub.ts:130-131` 就是映射到 `"`），
    // 弯引号在中文排版里更常见，但这是既有的取代表层，不在这条判据里评判
    expect(r.chapters[0].content).toContain('——"好"');
    expect(r.chapters[0].content).not.toContain("危险");
    expect(r.chapters[0].content).not.toContain("标题");
  });
});

describe("parseEpub：坏输入要报错，不许给一只空书", () => {
  it("缺 container.xml 直接报「无效的 EPUB 文件」", async () => {
    const e = twoChapters();
    delete e["META-INF/container.xml"];
    await expect(parseEpub(await epubFile(e))).rejects.toThrow(/container\.xml/);
  });

  it("container.xml 里没有 full-path 时报的是 OPF 那句", async () => {
    const e = twoChapters();
    e["META-INF/container.xml"] = "<?xml version='1.0'?><container><rootfiles></rootfiles></container>";
    await expect(parseEpub(await epubFile(e))).rejects.toThrow(/OPF 文件路径/);
  });

  it("full-path 指向的 OPF 不在包里时要报错而不是返回空章节", async () => {
    const e = twoChapters();
    e["META-INF/container.xml"] = CONTAINER.replace("OEBPS/content.opf", "OEBPS/nope.opf");
    await expect(parseEpub(await epubFile(e))).rejects.toThrow(/OPF/);
  });

  it("OPF 里一个 manifest item 都没有 → 交出一章空的「全文」（现状如实钉）", async () => {
    const e = twoChapters();
    e["OEBPS/content.opf"] = opf([], []);
    const r = await parseEpub(await epubFile(e));
    // 实测：空的 ParseResult 不是空数组，而是 `splitByChapters` 给的一章 {title:"全文", content:""}。
    // 解析层**如实交出这个形状**、不报错，是刻意的分工：拦"一个字都没有"的活儿归导入那一步
    // （`useFileParser.ts` 的正文守卫，判 `content.trim()` 为空 → 不落库不上传不上架），
    // 判据在 `src/hooks/__tests__/useFileParser-guards.test.ts`。
    // 这条只钉住"解析层交出来的是什么形状"，别把它读成"空输入在门口就挡下了"。
    expect(r.chapters).toHaveLength(1);
    expect(r.chapters[0].title).toBe("全文");
    expect(r.totalChars).toBe(0);
  });

  it("条目数超过上限就整只拒掉（zip bomb 的第一道闸）", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    zip.file("META-INF/container.xml", CONTAINER);
    zip.file("OEBPS/content.opf", opf([], []));
    for (let i = 0; i <= 5000; i++) zip.file(`OEBPS/凑数/${i}.txt`, "");
    const buffer = await zip.generateAsync({ type: "arraybuffer" });
    await expect(parseEpub(new File([buffer], "bomb.epub"))).rejects.toThrow(/条目过多/);
  });
  // 注：另一道闸原来写的是"没有判据，也没法在单测里造"。2026-09-25 这一档把它造出来了
  // （给 `parseEpub` 开一个可注入的小上限），并且据此把闸的口径改了——见下面那一档。
});

/**
 * 上面那条注释放的是"造不出来"，这一档把它造出来了——顺带把那道闸的毛病定位换了一个：
 *
 * - **站得住的一半**：它把整只包（含**从不解压**的图片/字体）声明的体积加起来拦，
 *   于是 320MB 的图解 EPUB 被一句"解压后体积过大"误杀，而正文其实只有一百 KB。
 * - **站不住的一半（我原本的判断，被夹具推翻）**：我以为"声明 4 字节、实际几百 KB"
 *   的谎报包能骗过闸再在 `async("string")` 上撑死页面。实测 **JSZip 自己在校验**
 *   ——inflate 完对不上声明就抛 `uncompressed data size mismatch`（见下面第一条），
 *   所以谎报这条路本来就是封的，闸不必为它加逻辑。留着这条判据就是为了把这个结论钉住：
 *   哪天 JSZip 不校验了，它会红。
 *
 * 上限从这里开始量的是**真解进来的文本字节**，判据需要一个能注入的小上限
 * （`parseEpub(file, { maxDecompressedBytes })`，生产默认值与取值依据见 `epub.ts`）。
 */
describe("第二道闸：量真解进来的文本字节，图片与字体不计入", () => {
  const KB = 1024;
  /** 造约 N KB 的正文 */
  const fat = (marker: string, kb: number) =>
    `<html><body><p>${marker}</p><p>${("正文" + marker + "。").repeat(Math.max(1, Math.floor((kb * KB) / 10)))}</p></body></html>`;

  /** 把每条头里的 uncompressedSize 改成 4 字节（本地头偏移 22、中央目录偏移 24，小端 u32） */
  function lieAboutSizes(buffer: ArrayBuffer): ArrayBuffer {
    const out = buffer.slice(0);
    const view = new DataView(out);
    const bytes = new Uint8Array(out);
    const sig = (i: number, a: number, b: number) => bytes[i] === a && bytes[i + 1] === b;
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (sig(i, 0x50, 0x4b) && sig(i + 2, 0x03, 0x04)) view.setUint32(i + 22, 4, true);
      else if (sig(i, 0x50, 0x4b) && sig(i + 2, 0x01, 0x02)) view.setUint32(i + 24, 4, true);
    }
    return out;
  }

  /** 一册 spine 有 `count` 章、每章约 `kbPer` KB 的样本 */
  function manyChapters(count: number, kbPer: number): Record<string, string> {
    const items: string[] = [];
    const ids: string[] = [];
    const entries: Record<string, string> = { "META-INF/container.xml": CONTAINER };
    for (let i = 0; i < count; i++) {
      items.push(`<item id="c${i}" href="chap${i}.xhtml" media-type="application/xhtml+xml"/>`);
      ids.push(`c${i}`);
      entries[`OEBPS/chap${i}.xhtml`] = fat(`第${i}章`, kbPer);
    }
    entries["OEBPS/content.opf"] = opf(items, ids);
    return entries;
  }

  /** 往一册里塞一张不进 spine 的大图（manifest 里有它，spine 里没有） */
  function withImage(entries: Record<string, string>, kb: number): Record<string, string> {
    const e = { ...entries };
    e["OEBPS/cover.jpg"] = "x".repeat(kb * KB);
    const ids = Object.keys(e).filter((k) => /^OEBPS\/chap\d+\.xhtml$/.test(k)).map((k) => k.match(/chap(\d+)/)![1]);
    e["OEBPS/content.opf"] = opf(
      [
        '<item id="img" href="cover.jpg" media-type="image/jpeg"/>',
        ...ids.map((i) => `<item id="c${i}" href="chap${i}.xhtml" media-type="application/xhtml+xml"/>`),
      ],
      ["img", ...ids.map((i) => `c${i}`)],
    );
    return e;
  }

  it("谎报 header 的包由 JSZip 当场抛，不会静默解出真值（所以闸不必防谎报）", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    for (const [p, c] of Object.entries(manyChapters(1, 60))) zip.file(p, c);
    const lied = lieAboutSizes(await zip.generateAsync({ type: "arraybuffer" }));
    // 判的是"不静默放行"，不钉 JSZip 那句英文原文——文案换掉不算回归
    await expect(parseEpub(new File([lied], "lie.epub"))).rejects.toThrow();
  });

  it("不在 spine 里的大图不许把书一起杀掉：正文只有一百 KB 就该导得进来", async () => {
    const e = withImage(manyChapters(2, 40), 600);
    const r = await parseEpub(await epubFile(e, "图解本.epub"), { maxDecompressedBytes: 100 * KB });
    expect(r.chapters).toHaveLength(2);
    expect(r.chapters[0].content).toContain("第0章");
  });

  it("换口径之后闸还在：spine 文本自己超上限必须拦", async () => {
    const e = manyChapters(3, 80); // 三章各 80KB，累计远超 100KB
    await expect(
      parseEpub(await epubFile(e), { maxDecompressedBytes: 100 * KB })
    ).rejects.toThrow(/解压后体积过大/);
  });

  it("报错文案要给出实测值，不能只说一句「过大」", async () => {
    await expect(
      parseEpub(await epubFile(manyChapters(3, 80)), { maxDecompressedBytes: 100 * KB })
    ).rejects.toThrow(/0\.\d+MB|1\d*MB/);
  });

  it("没超上限的正常书不受影响", async () => {
    const r = await parseEpub(await epubFile(manyChapters(2, 20)), { maxDecompressedBytes: 100 * KB });
    expect(r.chapters).toHaveLength(2);
  });
});
