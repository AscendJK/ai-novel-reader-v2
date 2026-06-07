/**
 * Generate PWA icon PNGs from SVG source.
 * Run: node scripts/gen-pwa-assets.mjs
 */
import fs from "fs";
import path from "path";
import sharp from "sharp";

const publicDir = path.resolve(import.meta.dirname, "../public");
const srcSvg = path.join(publicDir, "favicon.svg");

const svgBuf = fs.readFileSync(srcSvg);

// Generate square PNG icons (any purpose)
for (const size of [192, 512]) {
  const out = path.join(publicDir, `icon-${size}.png`);
  await sharp(svgBuf).resize(size, size).png().toFile(out);
  console.log(`✓ icon-${size}.png`);
}

// Generate maskable icon with ~10% padding (safe zone for Android)
{
  const size = 512;
  const padding = Math.round(size * 0.1); // 10% padding
  const innerSize = size - padding * 2;
  const inner = await sharp(svgBuf).resize(innerSize, innerSize).png().toBuffer();
  const out = path.join(publicDir, "icon-512-maskable.png");
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 10, g: 10, b: 10, alpha: 1 } },
  })
    .composite([{ input: inner, left: padding, top: padding }])
    .png()
    .toFile(out);
  console.log("✓ icon-512-maskable.png");
}

// Generate screenshot PNGs
const screenshots = [
  { src: "screenshot-desktop.svg", w: 1280, h: 720 },
  { src: "screenshot-mobile.svg", w: 720, h: 1280 },
];

for (const { src, w, h } of screenshots) {
  const inPath = path.join(publicDir, src);
  const outPath = path.join(publicDir, src.replace(".svg", ".png"));
  await sharp(fs.readFileSync(inPath)).resize(w, h).png().toFile(outPath);
  console.log(`✓ ${src.replace(".svg", ".png")}`);
}

console.log("Done.");
