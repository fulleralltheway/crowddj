import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");
const sourceIcon = path.join(publicDir, "icon-512.png");
const BG_COLOR = "#0a0a0a";

async function generateMaskableIcons() {
  // Maskable icons: the safe zone is the inner 80%, so we need 10% padding on each side.
  // We place the original icon (scaled to 80% of target) centered on a background.
  const sizes = [192, 512];

  for (const size of sizes) {
    const iconSize = Math.round(size * 0.8); // 80% of target = safe zone
    const resizedIcon = await sharp(sourceIcon)
      .resize(iconSize, iconSize, { fit: "contain", background: BG_COLOR })
      .png()
      .toBuffer();

    await sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: BG_COLOR,
      },
    })
      .composite([
        {
          input: resizedIcon,
          left: Math.round((size - iconSize) / 2),
          top: Math.round((size - iconSize) / 2),
        },
      ])
      .png()
      .toFile(path.join(publicDir, `icon-maskable-${size}.png`));

    console.log(`Created icon-maskable-${size}.png`);
  }
}

async function generateSplashScreens() {
  const splashSizes = [
    { width: 1170, height: 2532, label: "iPhone 12/13/14" },
    { width: 1179, height: 2556, label: "iPhone 14 Pro/15" },
    { width: 1290, height: 2796, label: "iPhone 14 Pro Max/15 Plus" },
    { width: 1206, height: 2622, label: "iPhone 16 Pro" },
    { width: 1320, height: 2868, label: "iPhone 16 Pro Max" },
  ];

  for (const { width, height, label } of splashSizes) {
    // Icon size: roughly 20% of the screen width
    const iconSize = Math.round(width * 0.2);
    const resizedIcon = await sharp(sourceIcon)
      .resize(iconSize, iconSize, { fit: "contain", background: BG_COLOR })
      .png()
      .toBuffer();

    // Create "PartyQueue" text as SVG
    const fontSize = Math.round(width * 0.08);
    const textY = Math.round(height / 2 + iconSize / 2 + fontSize * 0.8);
    const textSvg = Buffer.from(`
      <svg width="${width}" height="${height}">
        <style>
          @font-face {
            font-family: 'system';
            src: local('-apple-system'), local('BlinkMacSystemFont'), local('Segoe UI'), local('Helvetica Neue'), local('Arial');
          }
          text {
            font-family: system, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
            font-weight: 700;
            letter-spacing: 0.02em;
          }
        </style>
        <text x="${width / 2}" y="${textY}" text-anchor="middle" fill="white" font-size="${fontSize}" font-weight="700" font-family="sans-serif">PartyQueue</text>
      </svg>
    `);

    const iconLeft = Math.round((width - iconSize) / 2);
    const iconTop = Math.round(height / 2 - iconSize / 2 - fontSize * 0.4);

    await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: BG_COLOR,
      },
    })
      .composite([
        { input: resizedIcon, left: iconLeft, top: iconTop },
        { input: textSvg, left: 0, top: 0 },
      ])
      .png()
      .toFile(path.join(publicDir, `splash-${width}x${height}.png`));

    console.log(`Created splash-${width}x${height}.png (${label})`);
  }
}

async function main() {
  console.log("Generating PWA assets from icon-512.png...\n");
  await generateMaskableIcons();
  console.log("");
  await generateSplashScreens();
  console.log("\nDone! All assets saved to public/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
