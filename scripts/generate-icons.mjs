import sharp from 'sharp';

// CrowdDJ icon: music note on dark background with green accent
// Matches the app's existing logo SVG and color scheme
const sizes = [192, 512];

for (const size of sizes) {
  const padding = Math.round(size * 0.18);
  const noteSize = size - padding * 2;

  // Create SVG with the music note icon on a rounded-rect dark background
  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#111118"/>
          <stop offset="100%" stop-color="#0a0a0f"/>
        </linearGradient>
        <linearGradient id="glow" x1="0.3" y1="0" x2="0.7" y2="1">
          <stop offset="0%" stop-color="#1db954"/>
          <stop offset="100%" stop-color="#17a34a"/>
        </linearGradient>
      </defs>
      <!-- Background -->
      <rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="url(#bg)"/>
      <!-- Subtle green glow behind the note -->
      <circle cx="${size / 2}" cy="${size * 0.52}" r="${size * 0.28}" fill="#1db954" opacity="0.08"/>
      <!-- Music note -->
      <g transform="translate(${padding}, ${padding})">
        <svg viewBox="0 0 24 24" width="${noteSize}" height="${noteSize}" fill="url(#glow)">
          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
        </svg>
      </g>
    </svg>
  `;

  await sharp(Buffer.from(svg))
    .resize(size, size)
    .png()
    .toFile(`public/icon-${size}.png`);

  console.log(`Generated icon-${size}.png`);
}

// Also generate apple-touch-icon (180x180)
const appleSize = 180;
const applePad = Math.round(appleSize * 0.18);
const appleNote = appleSize - applePad * 2;
const appleSvg = `
  <svg width="${appleSize}" height="${appleSize}" viewBox="0 0 ${appleSize} ${appleSize}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#111118"/>
        <stop offset="100%" stop-color="#0a0a0f"/>
      </linearGradient>
      <linearGradient id="glow" x1="0.3" y1="0" x2="0.7" y2="1">
        <stop offset="0%" stop-color="#1db954"/>
        <stop offset="100%" stop-color="#17a34a"/>
      </linearGradient>
    </defs>
    <rect width="${appleSize}" height="${appleSize}" rx="${Math.round(appleSize * 0.22)}" fill="url(#bg)"/>
    <circle cx="${appleSize / 2}" cy="${appleSize * 0.52}" r="${appleSize * 0.28}" fill="#1db954" opacity="0.08"/>
    <g transform="translate(${applePad}, ${applePad})">
      <svg viewBox="0 0 24 24" width="${appleNote}" height="${appleNote}" fill="url(#glow)">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
      </svg>
    </g>
  </svg>
`;

await sharp(Buffer.from(appleSvg))
  .resize(appleSize, appleSize)
  .png()
  .toFile('public/apple-touch-icon.png');

console.log('Generated apple-touch-icon.png');

// Generate favicon (32x32)
const favSize = 32;
const favPad = Math.round(favSize * 0.12);
const favNote = favSize - favPad * 2;
const favSvg = `
  <svg width="${favSize}" height="${favSize}" viewBox="0 0 ${favSize} ${favSize}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${favSize}" height="${favSize}" rx="${Math.round(favSize * 0.22)}" fill="#111118"/>
    <g transform="translate(${favPad}, ${favPad})">
      <svg viewBox="0 0 24 24" width="${favNote}" height="${favNote}" fill="#1db954">
        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
      </svg>
    </g>
  </svg>
`;

await sharp(Buffer.from(favSvg))
  .resize(favSize, favSize)
  .png()
  .toFile('public/favicon.png');

// Also create ICO-compatible 32x32
await sharp(Buffer.from(favSvg))
  .resize(32, 32)
  .png()
  .toFile('public/favicon.ico');

console.log('Generated favicon.png + favicon.ico');
console.log('Done!');
