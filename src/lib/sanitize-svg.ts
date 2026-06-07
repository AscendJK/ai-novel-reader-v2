import DOMPurify from "dompurify";

/**
 * 消毒 SVG 字符串，移除危险的标签和属性（script、事件处理器等）。
 * 用于 AI 生成的 SVG 内容，防止 XSS 攻击。
 */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true },
    ALLOWED_TAGS: [
      "svg", "g", "path", "circle", "rect", "text", "tspan",
      "line", "polygon", "polyline", "ellipse", "defs", "style",
      "marker", "use", "symbol", "clipPath", "mask", "pattern",
      "image", "linearGradient", "radialGradient", "stop", "title", "desc",
    ],
    ALLOWED_ATTR: [
      "viewBox", "fill", "stroke", "stroke-width", "stroke-dasharray",
      "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2",
      "width", "height", "transform", "font-size", "font-family", "font-weight",
      "text-anchor", "dominant-baseline", "class", "id", "style",
      "opacity", "fill-opacity", "stroke-opacity",
      "points", "offset", "stop-color", "stop-opacity",
      "gradientUnits", "gradientTransform",
      "href", "xlink:href", "preserveAspectRatio",
    ],
    FORBID_ATTR: [
      "onload", "onerror", "onclick", "onmouseover", "onmouseout",
      "onfocus", "onblur", "onresize", "onscroll", "onunload",
      "onabort", "onanimationend", "onanimationstart",
    ],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "foreignObject"],
  });
}
