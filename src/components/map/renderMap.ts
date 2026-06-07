/**
 * 地图渲染函数
 * 连线 + 势力颜色 + 文字避让 + Tooltip + 力导向布局
 */

import type { MapData } from "@/agents/types";
import { forceSimulation, forceCollide, forceLink, forceManyBody, forceCenter, forceX, forceY } from "d3-force";

// ── 配置 ──────────────────────────────────────────────────────────

/** 基础地图尺寸 */
const BASE_WIDTH = 1000;
const BASE_HEIGHT = 1000;
const PADDING = 60;

/** 层级颜色配置 */
const LAYER_COLORS = [
  "#dc2626", // 层级 1（红色）
  "#f59e0b", // 层级 2（橙色）
  "#8b5cf6", // 层级 3（紫色）
  "#059669", // 层级 4（绿色）
  "#38bdf8", // 层级 5（蓝色）
  "#ec4899", // 层级 6（粉色）
];

/** 势力颜色配置 */
const FORCE_COLORS: Record<string, string> = {
  曹魏: "#3b82f6",
  蜀汉: "#ef4444",
  东吴: "#22c55e",
  袁绍: "#a855f7",
  吕布: "#f97316",
  刘表: "#06b6d4",
  刘璋: "#84cc16",
  马超: "#eab308",
  公孙瓒: "#6366f1",
  张鲁: "#14b8a6",
  孟获: "#d946ef",
  董卓: "#64748b",
};

// ── 工具函数 ──────────────────────────────────────────────────────

/** 坐标转换：0-1000 → SVG 实际坐标 */
function scaleX(x: number): number {
  return PADDING + (x / 1000) * (BASE_WIDTH - 2 * PADDING);
}

function scaleY(y: number): number {
  return PADDING + (y / 1000) * (BASE_HEIGHT - 2 * PADDING);
}

/** d3-force 节点接口 */
interface ForceNode {
  id: string;
  x: number;
  y: number;
  level: number;
  importance: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
}

/** d3-force 连接接口 */
interface ForceLink {
  source: string;
  target: string;
}

/**
 * 使用力导向布局调整地点位置
 * - level 1 的地点固定不动
 * - level 2 的地点之间保持最小距离 200
 * - level 3 及以下的地点之间保持最小距离 50
 * - 子级跟父级之间最小距离 50
 */
function applyForceLayout(mapData: MapData): MapData {
  if (!mapData.places?.length) return mapData;

  // 找到 level 1 的地点（固定不动）
  const fixedPlaces = mapData.places.filter(p => p.level === 1);
  const fixedIds = new Set(fixedPlaces.map(p => p.id));

  // 创建节点数组（level 2 及以下的地点）
  const nodes: ForceNode[] = mapData.places
    .filter(p => p.level > 1)
    .map(place => ({
      id: place.id,
      x: place.x,
      y: place.y,
      level: place.level,
      importance: place.importance || 5,
    }));

  // 如果没有需要调整的地点，直接返回
  if (nodes.length === 0) return mapData;

  // 创建连接数组（只包含非固定节点之间的连接）
  const links: ForceLink[] = mapData.places
    .filter(place => place.parentId && !fixedIds.has(place.id) && !fixedIds.has(place.parentId))
    .map(place => ({
      source: place.parentId,
      target: place.id,
    }));

  // 创建碰撞力（根据层级设置不同距离）
  const collisionForce = forceCollide<ForceNode>()
    .radius((d) => {
      // level 2 之间最小距离 200，level 3 及以下最小距离 50
      return d.level === 2 ? 200 : 50;
    })
    .strength(1);

  // 创建连接力（子级跟父级之间最小距离 50）
  const linkForce = forceLink<ForceNode, ForceLink>(links)
    .id((d) => d.id)
    .distance(50)
    .strength(0.3);

  // 创建力导向模拟
  const simulation = forceSimulation(nodes)
    // 碰撞力
    .force("collide", collisionForce)
    // 连接力
    .force("link", linkForce)
    // 排斥力：让节点分开
    .force("charge", forceManyBody().strength(-100))
    // 中心力：向中心靠拢
    .force("center", forceCenter(500, 500).strength(0.1))
    // X 轴力：向中心靠拢
    .force("x", forceX(500).strength(0.05))
    // Y 轴力：向中心靠拢
    .force("y", forceY(500).strength(0.05))
    // 停止模拟（运行 300 次迭代）
    .stop();

  // 运行模拟
  for (let i = 0; i < 300; i++) {
    simulation.tick();
  }

  // 限制坐标在 0-1000 范围内
  nodes.forEach(node => {
    node.x = Math.max(50, Math.min(950, node.x));
    node.y = Math.max(50, Math.min(950, node.y));
  });

  // 创建调整后的 mapData（level 1 保持原位）
  const adjustedPlaces = mapData.places.map(place => {
    // level 1 的地点保持原位
    if (fixedIds.has(place.id)) {
      return place;
    }
    // level 2 及以下的地点使用调整后的位置
    const node = nodes.find(n => n.id === place.id);
    return {
      ...place,
      x: node ? Math.round(node.x) : place.x,
      y: node ? Math.round(node.y) : place.y,
    };
  });

  return {
    ...mapData,
    places: adjustedPlaces,
  };
}

/** 获取层级颜色 */
function getLayerColor(level: number): string {
  return LAYER_COLORS[(level - 1) % LAYER_COLORS.length];
}

/** 动态势力颜色调色板 */
const FORCE_PALETTE = ["#3b82f6", "#ef4444", "#22c55e", "#a855f7", "#f97316", "#06b6d4", "#84cc16", "#eab308", "#6366f1", "#14b8a6", "#d946ef", "#ec4899"];

/** 简单字符串哈希 */
function hashCode(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/** 获取势力颜色 */
function getForceColor(affiliation: string): string {
  if (!affiliation) return "#6b7280";
  if (FORCE_COLORS[affiliation]) return FORCE_COLORS[affiliation];
  // 动态分配颜色
  return FORCE_PALETTE[Math.abs(hashCode(affiliation)) % FORCE_PALETTE.length];
}

/** 根据层级获取图标大小 */
function getLevelScale(level: number, maxLevel: number): number {
  return 1 + (maxLevel - level) * 0.3;
}

// ── 渲染函数 ──────────────────────────────────────────────────────

/** 渲染羊皮卷背景（真实效果） */
function renderBackground(width: number = BASE_WIDTH, height: number = BASE_HEIGHT): string {
  return `
    <defs>
      <!-- 纸张纹理 -->
      <filter id="paper-noise" x="0%" y="0%" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="5" stitchTiles="stitch" seed="3" result="noise" />
        <feColorMatrix type="saturate" values="0" in="noise" result="grayNoise" />
        <feBlend in="SourceGraphic" in2="grayNoise" mode="multiply" result="blended" />
      </filter>
      <!-- 边缘暗角（四个边都深） -->
      <linearGradient id="edge-top" x1="0%" y1="0%" x2="0%" y2="15%">
        <stop offset="0%" stop-color="rgba(80,50,20,0.5)" />
        <stop offset="100%" stop-color="rgba(80,50,20,0)" />
      </linearGradient>
      <linearGradient id="edge-bottom" x1="0%" y1="85%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="rgba(80,50,20,0)" />
        <stop offset="100%" stop-color="rgba(80,50,20,0.5)" />
      </linearGradient>
      <linearGradient id="edge-left" x1="0%" y1="0%" x2="15%" y2="0%">
        <stop offset="0%" stop-color="rgba(80,50,20,0.5)" />
        <stop offset="100%" stop-color="rgba(80,50,20,0)" />
      </linearGradient>
      <linearGradient id="edge-right" x1="85%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="rgba(80,50,20,0)" />
        <stop offset="100%" stop-color="rgba(80,50,20,0.5)" />
      </linearGradient>
      <!-- 中间深浅变化 -->
      <radialGradient id="spot-1" cx="30%" cy="40%" r="25%">
        <stop offset="0%" stop-color="rgba(60,40,15,0.15)" />
        <stop offset="100%" stop-color="rgba(60,40,15,0)" />
      </radialGradient>
      <radialGradient id="spot-2" cx="70%" cy="60%" r="20%">
        <stop offset="0%" stop-color="rgba(60,40,15,0.12)" />
        <stop offset="100%" stop-color="rgba(60,40,15,0)" />
      </radialGradient>
      <radialGradient id="spot-3" cx="50%" cy="25%" r="18%">
        <stop offset="0%" stop-color="rgba(60,40,15,0.1)" />
        <stop offset="100%" stop-color="rgba(60,40,15,0)" />
      </radialGradient>
    </defs>
    <!-- 基础羊皮色 -->
    <rect width="${width}" height="${height}" fill="#d4a76a" />
    <!-- 纹理叠加 -->
    <rect width="${width}" height="${height}" filter="url(#paper-noise)" opacity="0.12" />
    <!-- 中间深浅变化（不规则斑点） -->
    <rect width="${width}" height="${height}" fill="url(#spot-1)" />
    <rect width="${width}" height="${height}" fill="url(#spot-2)" />
    <rect width="${width}" height="${height}" fill="url(#spot-3)" />
    <!-- 边缘暗角（四个边） -->
    <rect width="${width}" height="${height}" fill="url(#edge-top)" />
    <rect width="${width}" height="${height}" fill="url(#edge-bottom)" />
    <rect width="${width}" height="${height}" fill="url(#edge-left)" />
    <rect width="${width}" height="${height}" fill="url(#edge-right)" />
    <!-- 边框 -->
    <rect x="2" y="2" width="${width - 4}" height="${height - 4}"
          fill="none" stroke="#8b6914" stroke-width="2" rx="3" />
    <rect x="6" y="6" width="${width - 12}" height="${height - 12}"
          fill="none" stroke="#a07828" stroke-width="1" rx="2" opacity="0.4" />
  `;
}

/** 渲染连线（父子关系） */
function renderConnections(mapData: MapData, svgWidth: number = BASE_WIDTH, svgHeight: number = BASE_HEIGHT): string {
  if (!mapData.places?.length || !mapData.layers?.length) return "";

  const topLevel = Math.min(...mapData.layers.map(l => l.level));

  return mapData.places
    .filter(place => place.parentId) // 只渲染有父级的地点
    .map(place => {
      const parent = mapData.places.find(p => p.id === place.parentId);
      if (!parent) return "";

      // 取消 level 1 和 level 2 之间的连线
      if (parent.level === topLevel) return "";

      // 使用实际 SVG 坐标（0-1000 范围）
      const x1 = PADDING + (parent.x / 1000) * (svgWidth - 2 * PADDING);
      const y1 = PADDING + (parent.y / 1000) * (svgHeight - 2 * PADDING);
      const x2 = PADDING + (place.x / 1000) * (svgWidth - 2 * PADDING);
      const y2 = PADDING + (place.y / 1000) * (svgHeight - 2 * PADDING);

      // 连线颜色：使用父级的层级颜色
      const color = getLayerColor(parent.level);

      return `
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
              stroke="${color}" stroke-width="1.5" opacity="0.6"
              stroke-dasharray="4,2" />
      `;
    })
    .join("\n");
}

/** 渲染地点（不包括最大层级） */
function renderPlaces(mapData: MapData, svgWidth: number = BASE_WIDTH, svgHeight: number = BASE_HEIGHT): string {
  if (!mapData.places?.length || !mapData.layers?.length) return "";

  const maxLevel = Math.max(...mapData.layers.map(l => l.level));
  const topLevel = Math.min(...mapData.layers.map(l => l.level));

  // 过滤掉最大层级的地点
  const placesToRender = mapData.places.filter(p => p.level > topLevel);
  if (placesToRender.length === 0) return "";

  return placesToRender.map((place) => {
    // 使用实际 SVG 坐标（0-1000 范围）
    const x = PADDING + (place.x / 1000) * (svgWidth - 2 * PADDING);
    const y = PADDING + (place.y / 1000) * (svgHeight - 2 * PADDING);
    const levelScale = getLevelScale(place.level, maxLevel);
    const color = getLayerColor(place.level);
    const size = 6 * levelScale;

    // 势力边框颜色
    const borderColor = getForceColor(place.affiliation);

    const fontSize = 10;

    // Tooltip 内容
    const tooltipContent = `${place.name} (${place.type})
${place.affiliation ? `势力: ${place.affiliation}` : ""}
重要程度: ${place.importance || 5}/10

${place.description}`;

    return `
      <g class="place-group" data-id="${place.id}" style="cursor: pointer;">
        <title>${tooltipContent}</title>
        <!-- 地点圆圈 -->
        <circle cx="${x}" cy="${y}" r="${size}"
                fill="${color}" stroke="${borderColor}" stroke-width="2" opacity="0.9" />
        <!-- 地点名称（紧随圆圈下方） -->
        <text x="${x}" y="${y + size + 12}"
              text-anchor="middle" fill="#3a2a0a"
              font-size="${fontSize}" font-weight="500">
          ${place.name}
        </text>
      </g>
    `;
  }).join("\n");
}

/** 渲染最大层级名称（在地图中间上边居中） */
function renderTopLayerNames(mapData: MapData, zoom: number = 1): string {
  if (!mapData.layers?.length) return "";

  // 找到 level=1 的层级名称
  const topLayer = mapData.layers.find(l => l.level === 1);
  if (!topLayer) return "";

  // 在地图中间上边居中显示名称
  const centerX = (BASE_WIDTH * zoom) / 2 + 75; // 偏移侧边栏宽度的一半
  const startY = 45;

  return `
    <text x="${centerX}" y="${startY}" text-anchor="middle" fill="#6b3a0a"
          font-size="24" font-weight="bold" font-family="serif"
          stroke="#d4a76a" stroke-width="3" paint-order="stroke">
      ${topLayer.name}
    </text>
  `;
}

/** 渲染指北针 */
function renderCompass(width: number = BASE_WIDTH): string {
  const x = width - 50;
  const y = 50;

  return `
    <g transform="translate(${x}, ${y})">
      <circle cx="0" cy="0" r="20" fill="rgba(26, 21, 16, 0.8)" stroke="#4a3f2f" stroke-width="1" />
      <polygon points="0,-18 -5,-5 0,-8 5,-5" fill="#dc2626" />
      <polygon points="0,18 -5,5 0,8 5,5" fill="#6b7280" />
      <text x="0" y="-22" text-anchor="middle" fill="#d4c5a9" font-size="10" font-weight="bold">N</text>
    </g>
  `;
}

/** 渲染侧边栏内容（地理层级 + 势力，不渲染背景和边框） */
function renderSidebarContent(mapData: MapData, svgHeight: number = BASE_HEIGHT): string {
  // 地理层级
  const layerItems = mapData.layers.map((layer, i) => {
    const itemY = i * 22;
    const color = getLayerColor(layer.level);
    return `
      <g transform="translate(12, ${itemY})">
        <circle cx="8" cy="8" r="5" fill="${color}" stroke="#5a4a2a" stroke-width="1" />
        <text x="22" y="12" fill="#4a3a1a" font-size="11" font-weight="500">
          ${layer.level}: ${layer.name}
        </text>
      </g>
    `;
  }).join("\n");

  // 势力
  const forces = new Set<string>();
  mapData.places?.forEach(p => {
    if (p.affiliation) forces.add(p.affiliation);
  });

  const forceItems = Array.from(forces).map((force, i) => {
    const itemY = i * 22;
    const color = getForceColor(force);
    return `
      <g transform="translate(12, ${itemY})">
        <circle cx="8" cy="8" r="5" fill="${color}" stroke="#5a4a2a" stroke-width="1" />
        <text x="22" y="12" fill="#4a3a1a" font-size="11" font-weight="500">
          ${force}
        </text>
      </g>
    `;
  }).join("\n");

  const layerHeight = mapData.layers.length * 22 + 35;

  return `
    <!-- 地理层级 -->
    <text x="12" y="22" fill="#5a3a0a" font-size="13" font-weight="bold">地理层级</text>
    <g transform="translate(0, 38)">
      ${layerItems}
    </g>

    <!-- 分隔线 -->
    <line x1="12" y1="${layerHeight}" x2="138" y2="${layerHeight}"
          stroke="#a07828" stroke-width="1" opacity="0.5" />

    <!-- 势力 -->
    <text x="12" y="${layerHeight + 20}" fill="#5a3a0a" font-size="13" font-weight="bold">势力</text>
    <g transform="translate(0, ${layerHeight + 35})">
      ${forceItems}
    </g>
  `;
}

// ── 主渲染函数 ────────────────────────────────────────────────────

/**
 * 将 MapData 渲染为 SVG 字符串
 * @param mapData 地图数据
 * @param useForceLayout 是否使用力导向布局（默认 false）
 */
export function renderMapToSvg(mapData: MapData, useForceLayout: boolean = false): string {
  const svgWidth = BASE_WIDTH;
  const svgHeight = BASE_HEIGHT;
  const sidebarWidth = 150;
  const totalWidth = svgWidth + sidebarWidth;

  // 应用力导向布局
  const adjustedMapData = useForceLayout ? applyForceLayout(mapData) : mapData;

  return `<svg width="${totalWidth + 20}" height="${svgHeight + 50}"
               viewBox="-10 0 ${totalWidth + 30} ${svgHeight + 50}"
               xmlns="http://www.w3.org/2000/svg"
               style="touch-action: none; pointer-events: none;">
  <style>
    .place-group, .place-group * { pointer-events: auto; }
  </style>
  <defs>
    <!-- 纸张纹理 -->
    <filter id="paper-noise" x="0%" y="0%" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="5" stitchTiles="stitch" seed="3" result="noise" />
      <feColorMatrix type="saturate" values="0" in="noise" result="grayNoise" />
      <feBlend in="SourceGraphic" in2="grayNoise" mode="multiply" result="blended" />
    </filter>
    <!-- 边缘暗角（四个边都深） -->
    <linearGradient id="edge-top" x1="0%" y1="0%" x2="0%" y2="15%">
      <stop offset="0%" stop-color="rgba(80,50,20,0.5)" />
      <stop offset="100%" stop-color="rgba(80,50,20,0)" />
    </linearGradient>
    <linearGradient id="edge-bottom" x1="0%" y1="85%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="rgba(80,50,20,0)" />
      <stop offset="100%" stop-color="rgba(80,50,20,0.5)" />
    </linearGradient>
    <linearGradient id="edge-left" x1="0%" y1="0%" x2="15%" y2="0%">
      <stop offset="0%" stop-color="rgba(80,50,20,0.5)" />
      <stop offset="100%" stop-color="rgba(80,50,20,0)" />
    </linearGradient>
    <linearGradient id="edge-right" x1="85%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="rgba(80,50,20,0)" />
      <stop offset="100%" stop-color="rgba(80,50,20,0.5)" />
    </linearGradient>
    <!-- 中间深浅变化 -->
    <radialGradient id="spot-1" cx="30%" cy="40%" r="25%">
      <stop offset="0%" stop-color="rgba(60,40,15,0.15)" />
      <stop offset="100%" stop-color="rgba(60,40,15,0)" />
    </radialGradient>
    <radialGradient id="spot-2" cx="70%" cy="60%" r="20%">
      <stop offset="0%" stop-color="rgba(60,40,15,0.12)" />
      <stop offset="100%" stop-color="rgba(60,40,15,0)" />
    </radialGradient>
    <radialGradient id="spot-3" cx="50%" cy="25%" r="18%">
      <stop offset="0%" stop-color="rgba(60,40,15,0.1)" />
      <stop offset="100%" stop-color="rgba(60,40,15,0)" />
    </radialGradient>
  </defs>

  <!-- 统一背景（侧边栏 + 地图） -->
  <rect x="0" y="0" width="${totalWidth}" height="${svgHeight}" fill="#d4a76a" rx="3" />
  <rect x="0" y="0" width="${totalWidth}" height="${svgHeight}" filter="url(#paper-noise)" opacity="0.12" rx="3" />
  <rect x="0" y="0" width="${totalWidth}" height="${svgHeight}" fill="url(#spot-1)" rx="3" />
  <rect x="0" y="0" width="${totalWidth}" height="${svgHeight}" fill="url(#spot-2)" rx="3" />
  <rect x="0" y="0" width="${totalWidth}" height="${svgHeight}" fill="url(#spot-3)" rx="3" />
  <rect x="0" y="0" width="${totalWidth}" height="${svgHeight}" fill="url(#edge-top)" rx="3" />
  <rect x="0" y="0" width="${totalWidth}" height="${svgHeight}" fill="url(#edge-bottom)" rx="3" />
  <rect x="0" y="0" width="${totalWidth}" height="${svgHeight}" fill="url(#edge-left)" rx="3" />
  <rect x="0" y="0" width="${totalWidth}" height="${svgHeight}" fill="url(#edge-right)" rx="3" />
  <!-- 统一边框 -->
  <rect x="2" y="2" width="${totalWidth - 4}" height="${svgHeight - 4}"
        fill="none" stroke="#8b6914" stroke-width="2" rx="3" />
  <rect x="6" y="6" width="${totalWidth - 12}" height="${svgHeight - 12}"
        fill="none" stroke="#a07828" stroke-width="1" rx="2" opacity="0.4" />

  <!-- 侧边栏分隔线 -->
  <line x1="${sidebarWidth}" y1="10" x2="${sidebarWidth}" y2="${svgHeight - 10}"
        stroke="#8b6914" stroke-width="1" opacity="0.5" />

  <!-- 侧边栏内容（地理层级 + 势力） -->
  ${renderSidebarContent(mapData, svgHeight)}

  <!-- 连线（父子关系） -->
  ${renderConnections(adjustedMapData, svgWidth, svgHeight)}

  <!-- 地点 -->
  ${renderPlaces(adjustedMapData, svgWidth, svgHeight)}

  <!-- 最大层级名称 -->
  ${renderTopLayerNames(adjustedMapData)}

  <!-- 地图元素 -->
  ${renderCompass(svgWidth)}
</svg>`;
}

/**
 * 将 SVG 转换为 PNG Blob
 */
export async function renderSvgToPng(svgString: string, width = BASE_WIDTH + 150, height = BASE_HEIGHT + 50): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);

    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Failed to get canvas context"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);

      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Failed to create PNG blob"));
        },
        "image/png"
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load SVG image"));
    };

    img.src = url;
  });
}
