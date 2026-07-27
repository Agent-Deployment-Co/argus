// Builds the social card served at /og-image.png, the image that unfurls when a
// link to the docs site is shared.
//
//   bun run og-image
//
// The Activity screenshot, scaled to fit and sitting on a brand background with
// rounded corners and a drop shadow. The UI isn't meant to be readable at this
// size; it reads as "a dashboard". og:title and og:description supply the words.
//
// The screenshot keeps its full width, so nothing is cropped horizontally (that
// looks like a mistake). It's taller than the space once scaled to fit, so the
// bottom is trimmed instead.
//
// Re-run this after regenerating the Activity screenshot, then commit the result.

import sharp from "sharp";

const WIDTH = 1200;
const HEIGHT = 630;

// ADC palette, defined in docs/.vitepress/theme/style.css (--adc-*) and
// web/src/styles.css (same values, unprefixed). Use these names, not raw hex.
const SOFT_APRICOT = "#f3d7ba";

// The app's own background is Antique White (#f9ebdc), so the card sits on Soft
// Apricot: the next step down the same ramp. On Antique White the screenshot
// would dissolve into the backdrop and the rounding and shadow would do nothing.
const BACKGROUND = SOFT_APRICOT;

// Not a brand color. A shadow is light being blocked, so it darkens whatever is
// underneath rather than adding pigment of its own. Black at low alpha over Soft
// Apricot reads as Soft Apricot in shade, which is what's physically happening.
// A brand brown here would tint the shadow toward a hue that isn't in the scene.
const SHADOW = "#000000";

const INSET_X = 40;
const INSET_TOP = 34;
const INSET_BOTTOM = 38;

const CORNER_RADIUS = 12;
const SHADOW_BLUR = 14;
const SHADOW_OPACITY = 0.22;
const SHADOW_OFFSET_Y = 10;
// Room around the shadow so the blur has somewhere to fall off. The shadow layer
// has to sit entirely inside the canvas, so tightening the insets forces this
// down too, and with it how soft the shadow can get.
const SHADOW_PAD = 28;

const SCREENSHOT = "docs/images/screenshots/activity@1920x1080@2.webp";
const OUT = "docs/public/og-image.png";

const shotWidth = WIDTH - INSET_X * 2;
const shotHeight = HEIGHT - INSET_TOP - INSET_BOTTOM;

// The blurred shadow layer has to sit entirely inside the canvas. Sharp's own
// error for this ("Image to composite must have same dimensions or smaller")
// doesn't say which layer or why, so check it here where the numbers are.
const shadowW = shotWidth + SHADOW_PAD * 2;
const shadowH = shotHeight + SHADOW_PAD * 2;
const shadowLeft = INSET_X - SHADOW_PAD;
const shadowTop = INSET_TOP - SHADOW_PAD + SHADOW_OFFSET_Y;

if (
  shadowLeft < 0 ||
  shadowTop < 0 ||
  shadowLeft + shadowW > WIDTH ||
  shadowTop + shadowH > HEIGHT
) {
  throw new Error(
    `The ${shadowW}x${shadowH} shadow layer at ${shadowLeft},${shadowTop} doesn't fit the ` +
      `${WIDTH}x${HEIGHT} card. Lower SHADOW_PAD (${SHADOW_PAD}) or SHADOW_OFFSET_Y ` +
      `(${SHADOW_OFFSET_Y}), or raise the insets.`,
  );
}

const { width: srcWidth = 0, height: srcHeight = 0 } = await sharp(SCREENSHOT).metadata();

// Full width, trimmed from the bottom to whatever height the box allows.
const cropHeight = Math.round((srcWidth * shotHeight) / shotWidth);
if (cropHeight > srcHeight) {
  throw new Error(
    `Need ${cropHeight}px of a ${srcWidth}x${srcHeight} screenshot but it's only ${srcHeight} tall.`,
  );
}

const rounded = await sharp(SCREENSHOT)
  .extract({ left: 0, top: 0, width: srcWidth, height: cropHeight })
  .resize(shotWidth, shotHeight)
  .ensureAlpha()
  .composite([
    {
      input: Buffer.from(
        `<svg width="${shotWidth}" height="${shotHeight}">` +
          `<rect width="${shotWidth}" height="${shotHeight}" rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="#fff"/>` +
          `</svg>`,
      ),
      blend: "dest-in",
    },
  ])
  .png()
  .toBuffer();

// Same rounded silhouette, filled dark and blurred, sitting just behind and below.
const shadow = await sharp(
  Buffer.from(
    `<svg width="${shadowW}" height="${shadowH}">` +
      `<rect x="${SHADOW_PAD}" y="${SHADOW_PAD}" width="${shotWidth}" height="${shotHeight}" ` +
      `rx="${CORNER_RADIUS}" ry="${CORNER_RADIUS}" fill="${SHADOW}" fill-opacity="${SHADOW_OPACITY}"/>` +
      `</svg>`,
  ),
)
  .blur(SHADOW_BLUR)
  .png()
  .toBuffer();

await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: BACKGROUND } })
  .composite([
    { input: shadow, left: shadowLeft, top: shadowTop },
    { input: rounded, left: INSET_X, top: INSET_TOP },
  ])
  .png()
  .toFile(OUT);

console.log(`Wrote ${OUT} (${WIDTH}x${HEIGHT}), screenshot at ${shotWidth}x${shotHeight}`);
