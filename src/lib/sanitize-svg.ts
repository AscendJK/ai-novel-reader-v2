import DOMPurify from "dompurify";

/**
 * 消毒 SVG 字符串，移除危险的标签和属性（script、事件处理器等）。
 * 用于 AI 生成的 SVG 内容，防止 XSS 攻击。
 *
 * 口径是「profile + 减法」，不是白名单：DOMPurify 在 `USE_PROFILES` 存在时会**整体忽略**
 * `ALLOWED_TAGS`／`ALLOWED_ATTR`（实测：这两段整段删掉，输出一个字节都不变；而摘掉 profile
 * 会红三条"良性必须留着"）。曾经那两段列过 `use` 与 `dominant-baseline`，两者都活不下来，
 * 列了等于没列——留着的代价是给人"我加进白名单就放行了"的错觉。
 * 因此这里只留两件承重的：profile 决定形状集合，`FORBID_*` 从里面再挖掉 animate 系与事件属性。
 *
 * 它是**第二道防线**：地图字符串先由 `renderMap.ts` 的 `escapeXml` 把文本钉在元素正文里。
 * SVG profile 允许 `<style>` 与 `style` 属性且不校验规则体（`@import` 现在能过），所以拿掉
 * `escapeXml` 就等于把 CSS 那条口子摊开——改那一道之前先回来读这一句。
 */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true },
    FORBID_ATTR: [
      "onload", "onerror", "onclick", "onmouseover", "onmouseout",
      "onfocus", "onblur", "onresize", "onscroll", "onunload",
      "onabort", "onanimationend", "onanimationstart",
    ],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "foreignObject", "animate", "set", "animateTransform", "animateColor"],
  });
}
