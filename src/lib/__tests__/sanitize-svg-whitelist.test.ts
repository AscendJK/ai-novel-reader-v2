/**
 * sanitize-svg — 那道白名单首次有直接判据
 *
 * `sanitizeSvg` 有两个使用点，两处都把结果直接塞进 DOM：`NovelMapSection.tsx:390/557` 的
 * `dangerouslySetInnerHTML`，与 `:191` 导出 PNG 前先过一道。也就是说它漏一条就是一次 XSS。
 * 之前它只在地图组件的用例里"被经过"，白名单本身没人看着——**加一个允许项、少一条禁止项，
 * 界面上什么都不会变**。
 *
 * 判的两半同样重要：
 * 1. 危险的必须消失（script／事件属性／foreignObject／animate 系／iframe-object-embed／
 *    `javascript:` 的 href 与 xlink:href）；
 * 2. 良性的必须留着（结构与属性：`path d`、`viewBox`、`transform`、渐变与 `defs`、
 *    `text`/`title` 的文字、内部 `use href="#id"`）。**第二半不是顺手测**——白名单被"收紧
 *    成更安全"会把地图整张画黑，而那种改法在界面上只看得到"图没了"。
 *
 * 两条要留在明处的产品事实（`renderMap.ts:9-14` 写着第一条的同一件事）：
 * - profile **允许 `<style>` 标签与 `style` 属性，且不校验 CSS 规则体**。第 10 条用例钉住
 *   这个现状，不是认可它安全，而是因为"它能不能挡住 `@import`"这一问句的答案决定了上游
 *   `escapeXml` 那一道能不能被拿掉。哪天有人想给 `sanitizeSvg` 加 CSS 过滤，这条会红，
 *   那时应该顺便去核 `escapeXml` 还在不在。
 * - **这 34 行里承重的只有两处**：`USE_PROFILES: { svg: true }`，和 `FORBID_TAGS` 里的
 *   `"animateTransform"` 那一个词。三段 ALLOWED／FORBID 数组在 DOMPurify 3.4.7 上是装饰
 *   （见下面台账的 S25b／S26b／S27：整段删掉一条都不红）。所以"我把某项加进白名单了"
 *   不等于它生效，"我删掉了一行"也不等于放宽了——**要判断只能像第 16 条那样逐条实测**。
 *   最容易被这条骗到的改法是"顺手把 html 也放行"：那恰好是第 17 条唯一咬得住的一格。
 *
 * 有意不判：DOMPurify 自己的实现细节（它怎么删、删成什么形状）、注释与 `<?xml ?>` 声明的
 * 处理、属性顺序与空白规范化——这些是库的行为，不是这一层 34 行的决定。
 *
 * ── 变异台账（基线 sha `6fe3a73b`／1475 B，每刀手动一次一处、跑完立刻按字节还原并核 SHA）──
 * 对照：S0 18 绿 → 加第 17 条后 S0b 19 绿 → 第 5 条拆成三族后 S0c 19 绿。
 *
 * 咬住的（有牙）：
 * - `S13b` profile 顺手加 `html: true` → **1 红**，只有第 17 条。这一格只有它看着。
 *   （同一刀在写下第 17 条之前跑过 `S13`：**0 红**——所以那条用例不是补装饰。）
 * - `S17a` 删掉 `USE_PROFILES`（三段数组都留着）→ **3 红**：7b／11／16。红的是"良性那半"
 *   与第 16 条，方向正过来证明了一件事：**数组只在 profile 缺席时才接管**，profile 在场时
 *   它们整体被绕过。
 * - `S21` `sanitizeSvg` 整层直通 → **13 红**（危险那一半全红，6 只绿的正是"良性必须留着"）。
 * - `S24`/`S24b` 整个 `FORBID_TAGS` 删掉 → **1 红**（第 5 条）。拆族后归因到
 *   `animateTransform`——`<animate>`／`<set>` 没有这一行也照样被 profile 挡住。
 * - `S24c` 只从 `FORBID_TAGS` 里删掉 `"animateTransform"` 一个词 → **1 红**，同一第 5 条。
 *   实测漏出来的是整只活着回来的 `<path><animateTransform .../></path>`：SMIL 能随时间改写
 *   属性，这一格不是洁癖。
 *
 * 0 红的（记下来免得下次又当成"加固"）：`S1`/`S1b` foreignObject 从 FORBID 挪走、甚至请进
 * ALLOWED；`S2b` `script` 从 FORBID_TAGS 删掉；`S3d` `onload` 从 FORBID_ATTR 删掉；
 * `S4` `style` 从 ALLOWED_TAGS 删掉；`S23` `d` 从 ALLOWED_ATTR 删掉；`S25b` ALLOWED_TAGS
 * 整段不给；`S26b` ALLOWED_ATTR 整段不给；`S27` FORBID_ATTR 整段不给。库里都拦着。
 *
 * 作废的读数（原因写在明处）：`S2` 刀写成行中间的行注释，把数组剩下的部分整段吞进注释里
 * → `transform_failed=1 / reds=0 / sum[] 空`，是废读不是 0 红；`S3`/`S3b` 落刀没落上
 * （`markers=0`）；`S3c` 我的脚本把产品文件写成 0 字节（18 红全是"文件空了"），当场按基线还原。
 */
import { describe, it, expect } from "vitest";
import { sanitizeSvg } from "../sanitize-svg";

const has = (out: string, needle: string) => out.toLowerCase().includes(needle.toLowerCase());

describe("危险的东西必须消失", () => {
  it("1. 裸 `<script>` 整段没了（标签与里面那句都不留）", () => {
    const out = sanitizeSvg(`<svg><script>alert('xss')</script><circle r="1"/></svg>`);
    expect(has(out, "script")).toBe(false);
    expect(has(out, "alert")).toBe(false);
    expect(has(out, "circle")).toBe(true);
  });

  it("2. svg 根上的 onload 被剥掉，但元素本身留下（不许整张图被删空）", () => {
    const out = sanitizeSvg(`<svg onload="alert(1)" viewBox="0 0 10 10"><rect/></svg>`);
    expect(has(out, "onload")).toBe(false);
    expect(has(out, "alert")).toBe(false);
    expect(out).toMatch(/<svg[^>]*viewBox="0 0 10 10"/);
  });

  it("3. 事件属性按名字剥，与大小写／单双引号／有没有等号无关", () => {
    const out = sanitizeSvg(
      `<svg><circle ONLOAD="a(1)"/><circle onerror='a(2)'/><circle onclick=a(3)/></svg>`,
    );
    for (const bad of ["onload", "onerror", "onclick", "a(1)", "a(2)", "a(3)"]) {
      expect(has(out, bad), `残留了 ${bad}`).toBe(false);
    }
    expect(out.match(/<circle/g)).toHaveLength(3);
  });

  it("4. foreignObject（能塞进整页 HTML）整块没了，里面那句也跟着没了", () => {
    const out = sanitizeSvg(
      `<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></body></foreignObject><path/></svg>`,
    );
    expect(has(out, "foreignObject")).toBe(false);
    expect(has(out, "onerror")).toBe(false);
    expect(has(out, "alert")).toBe(false);
    expect(has(out, "path")).toBe(true);
  });

  it("5. animate／set／animateTransform 逐条禁（它们能把属性一点点改成 javascript:）", () => {
    // 三族各取一份，而且都装在同一只活下来的 `<rect>` 里：合起来判的话 `animate` 这个词
    // 盖得住 `animateTransform`，哪天只剩一族活着，红名字分不出是哪一族（S24 就是这么找到的）。
    const cases: Array<[RegExp, string]> = [
      [/<animate\b/i, `<svg><rect><animate attributeName="fill" values="javascript:alert(1)"/></rect><path/></svg>`],
      [/<set[\s/>]/i, `<svg><rect><set attributeName="onload" to="alert(1)"/></rect><path/></svg>`],
      [/<animateTransform\b/i, `<svg><path><animateTransform attributeName="transform" type="rotate" values="0"/></path></svg>`],
    ];
    for (const [tag, input] of cases) {
      const out = sanitizeSvg(input);
      expect(tag.test(out), `留下了 ${tag}：${out}`).toBe(false);
      expect(has(out, "javascript:"), input).toBe(false);
      expect(has(out, "alert"), input).toBe(false);
      expect(has(out, "path"), `良性那一只被连带吃掉：${input}`).toBe(true);
    }
  });

  it("6. iframe／object／embed 进不来", () => {
    // 良性那一圈放在最前面：`embed` 会让 HTML 解析器**跳出 SVG foreign content**，它之后的
    // 半张图会被当成 HTML 一起丢掉（第 18 条单独钉）。实测 iframe／object 不吃后半张。
    const out = sanitizeSvg(
      `<svg><circle r="2"/><iframe src="https://evil.example"/><object data="x"/><embed src="y"/></svg>`,
    );
    for (const bad of ["iframe", "object", "embed", "evil.example"]) {
      expect(has(out, bad), `残留了 ${bad}`).toBe(false);
    }
    expect(has(out, "circle")).toBe(true);
  });

  it("7. `javascript:` 的 href 与 xlink:href 都不许活着", () => {
    const evil = sanitizeSvg(
      `<svg><a href="javascript:alert(1)">点</a><use xlink:href="javascript:alert(2)"/><image href="javascript:alert(3)"/></svg>`,
    );
    expect(has(evil, "javascript:")).toBe(false);
    expect(has(evil, "alert")).toBe(false);
  });

  it("7b. `<use>` 整族现在就进不来（白名单里那一行 \"use\" 是死的）", () => {
    // 实测三种写法（无属性／href="#片段"／xlink:href="#片段"）都拿不到元素本体。钉住它不是
    // 因为今天要用——`renderMap.ts` 不产 `<use>`——而是那行白名单给人"内部片段引用是活的"
    // 的错觉；谁哪天靠 `<use>` 画重复图形，会先在这里红一次。
    for (const input of ["<svg><use/></svg>", '<svg><use href="#ar"/></svg>', '<svg><use xlink:href="#ar"/></svg>']) {
      expect(sanitizeSvg(input), input).toBe("<svg></svg>");
    }
  });

  it("8. 白名单外的标签（html 那套 div/img）不认，事件属性也跟着没了", () => {
    const out = sanitizeSvg(`<svg><div onclick="alert(1)">正文</div><img src="x" onerror="alert(2)"/></svg>`);
    expect(has(out, "onclick")).toBe(false);
    expect(has(out, "onerror")).toBe(false);
    expect(has(out, "alert")).toBe(false);
  });

  it("9. 根本不是 SVG 的片段（直接贴一段 HTML）也不留活口", () => {
    const out = sanitizeSvg(`<img src="x" onerror="alert(1)"><script>alert(2)</script>`);
    expect(has(out, "onerror")).toBe(false);
    expect(has(out, "script")).toBe(false);
    expect(has(out, "alert")).toBe(false);
  });

  it("10. 现状：`<style>` 标签与 style 属性都留着，规则体不校验——它只能是第二道防线", () => {
    const out = sanitizeSvg(
      `<svg><style>@import url("https://evil.example/x.css");</style><rect style="fill:url(#x)"/></svg>`,
    );
    expect(has(out, "<style>")).toBe(true);
    expect(has(out, "@import")).toBe(true);
    expect(has(out, 'style="fill:url(#x)"')).toBe(true);
  });
});

describe("良性的必须留着", () => {
  const MAP = [
    `<svg viewBox="0 0 200 120" width="200" height="120" class="map" id="m1">`,
    `<defs><linearGradient id="gg" gradientUnits="userSpaceOnUse">`,
    `<stop offset="0" stop-color="#111" stop-opacity="0.5"/><stop offset="1" stop-color="#222"/>`,
    `</linearGradient><marker id="ar" viewBox="0 0 4 4" refX="2"/></defs>`,
    `<g transform="translate(10,20)" opacity="0.9">`,
    `<path d="M0 0 L40 30" stroke="#333" stroke-width="2" stroke-dasharray="4 2" fill="url(#gg)"/>`,
    `<circle cx="10" cy="20" r="5" fill="#abc" fill-opacity="0.4"/>`,
    `<ellipse rx="3" ry="2"/><line x1="0" y1="0" x2="9" y2="9"/>`,
    `<polygon points="0,0 4,0 2,3"/><polyline points="0,0 3,3"/>`,
    `<rect x="1" y="2" width="8" height="9" rx="1"/>`,
    `<text x="4" y="6" font-size="9" font-family="sans-serif" font-weight="bold"`,
    `text-anchor="middle" dominant-baseline="central">西夏<tspan dy="8">漠</tspan></text>`,
    `<title>地点标题</title><desc>一段说明</desc>`,
    `<use href="#ar" x="3" y="3" xlink:href="#ar"/>`,
    `<clipPath id="cp"><rect/></clipPath><mask id="mk"><rect/></mask>`,
    `<pattern id="pt" width="4" height="4"><circle/></pattern>`,
    `<image href="#none" width="2" height="2" preserveAspectRatio="none"/>`,
    `</g></svg>`,
  ].join("");

  it("11. 一张正常地图逐条属性都不该被吃掉（被吃掉就是图缺块／整张黑）", () => {
    const out = sanitizeSvg(MAP);
    const keep = [
      'viewBox="0 0 200 120"', 'width="200"', 'class="map"', 'id="m1"',
      "linearGradient", 'stop-color="#111"', 'stop-opacity="0.5"', "gradientUnits", "marker",
      'transform="translate(10,20)"', 'opacity="0.9"', 'd="M0 0 L40 30"',
      'stroke-width="2"', 'stroke-dasharray="4 2"', 'fill="url(#gg)"',
      'cx="10"', 'rx="3"', 'x1="0"', "polygon", 'points="0,0 4,0 2,3"',
      'font-size="9"', 'font-family="sans-serif"', 'font-weight="bold"',
      'text-anchor="middle"', 'dy="8"',
      "clipPath", "mask", "pattern", "preserveAspectRatio", 'href="#none"',
    ];
    // `dominant-baseline` 与 `<use>` 不在这一列里：它们**写在白名单上却活不下来**，
    // 那两件事由第 16 与 7b 条单独钉住，不混进"良性必须留着"这一列。
    for (const bit of keep) expect(out, `吃掉了 ${bit}`).toContain(bit);
  });

  it("12. 文字与无障碍那两格（title／desc）留着，不是只留下形状", () => {
    const out = sanitizeSvg(MAP);
    expect(out).toContain("西夏");
    expect(out).toContain("漠");
    expect(out).toContain("地点标题");
    expect(out).toContain("一段说明");
  });

  it("13. 良性输入不被改动：消毒一次与两次完全一样（幂等）", () => {
    const once = sanitizeSvg(MAP);
    expect(sanitizeSvg(once)).toBe(once);
  });

  it("14. 良性那张图几乎原样通过（不许被削成空壳）", () => {
    const out = sanitizeSvg(MAP);
    expect(out.length).toBeGreaterThan(MAP.length - 40);
  });

  it("15. 空串与纯文本照直回来，不抛", () => {
    expect(sanitizeSvg("")).toBe("");
    expect(sanitizeSvg("没有标签")).toBe("没有标签");
  });
});

describe("读那三段数组之前要知道的两件事", () => {
  it("16. 数组不是最终集合：列了的不一定活，没列的不一定死", () => {
    // `dominant-baseline` 写在 ALLOWED_ATTR 里，实测活不下来；`baseline-shift` 一个字都没列，
    // 反而活着（它在 DOMPurify 3.4.7 内置的 svg 属性集里）。所以"我把某项加进白名单了"
    // 不等于它生效，"没写进去"也不等于挡住——要判只能像这样一条一条实测。
    expect(sanitizeSvg(`<svg><text dominant-baseline="central">a</text></svg>`)).not.toContain("dominant-baseline");
    expect(sanitizeSvg(`<svg><rect baseline-shift="1"/></svg>`)).toContain('baseline-shift="1"');
  });

  it("17. HTML 那一套形状进不来（这一条才真正钉住 USE_PROFILES 那一格）", () => {
    // 前三条只判"没有可执行的东西"，`USE_PROFILES` 顺手加上 html 也照样绿——实测过。
    // 而这里的结果是 `dangerouslySetInnerHTML`：HTML 标签在 SVG 里会让解析器跳出
    // foreign content（第 18 条拿 `embed` 把这件事钉成了读数），地图整块被换成外来内容。
    // 所以"只准 SVG 形状过来"
    // 本身就是安全属性，不是洁癖。
    const out = sanitizeSvg(`<svg><div id="d">正文</div><img src="x"/><iframe src="y"/></svg>`);
    for (const bad of ["<div", "<img", "<iframe", 'id="d"']) {
      expect(has(out, bad), `进来了 ${bad}`).toBe(false);
    }
  });

  it("18. `embed` 会把后半张图一起带走（可用性事实，不是安全洞）", () => {
    const out = sanitizeSvg(`<svg><circle r="1"/><embed src="y"/><circle r="2"/></svg>`);
    expect(has(out, "embed")).toBe(false);
    expect(out.match(/<circle/g)).toHaveLength(1);
    // 对照：iframe 与 object 同位置就不吃后半张——这一条防止有人把"禁标签"当成同一类去推
    expect(sanitizeSvg(`<svg><circle r="1"/><iframe src="x"/><circle r="2"/></svg>`).match(/<circle/g))
      .toHaveLength(2);
  });
});
