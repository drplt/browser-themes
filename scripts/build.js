const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const ADDON_DARK_DIR = path.join(ROOT_DIR, "firefox-addon");
const ADDON_LIGHT_DIR = path.join(ROOT_DIR, "firefox-addon-light");
const CHROME_DARK_DIR = path.join(ROOT_DIR, "chrome-addon");
const CHROME_LIGHT_DIR = path.join(ROOT_DIR, "chrome-addon-light");
const BUILD_DIR = path.join(ROOT_DIR, "build");

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    255,
  ];
}

/**
 * Generates the 64x200 Chrome theme_toolbar.png image with:
 * - Rows 0..23: Signature droplet.io Pink (#ff00b8) -> Berry (#ac00d7) cap
 * - Row 24: 1px anti-aliased transition pixel
 * - Rows 25..55: Vertical gradient from active tab top fill to toolbar background
 * - Rows 55..199: Solid toolbar background
 */
function createToolbarPng({ capStart, capEnd, transitionColor, tabTopColor, toolbarColor }) {
  const width = 64;
  const height = 200;
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    let color;
    if (y < 24) {
      const t = y / 23;
      color = lerpColor(capStart, capEnd, t);
    } else if (y === 24) {
      color = transitionColor;
    } else if (y <= 55) {
      const t = (y - 25) / (55 - 25);
      color = lerpColor(tabTopColor, toolbarColor, t);
    } else {
      color = toolbarColor;
    }

    const rowOffset = y * stride;
    raw[rowOffset] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const px = rowOffset + 1 + x * 4;
      raw[px] = color[0];
      raw[px + 1] = color[1];
      raw[px + 2] = color[2];
      raw[px + 3] = color[3];
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", idat),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function build() {
  // Ensure clean build directory
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const iconFiles = [
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon64.png",
    "icons/icon128.png",
  ];

  // Sync Dark icons from firefox-addon/icons to chrome-addon/icons
  fs.mkdirSync(path.join(CHROME_DARK_DIR, "icons"), { recursive: true });
  for (const icon of iconFiles) {
    fs.copyFileSync(
      path.join(ADDON_DARK_DIR, icon),
      path.join(CHROME_DARK_DIR, icon)
    );
  }

  // Sync Light icons from firefox-addon-light/icons to chrome-addon-light/icons
  fs.mkdirSync(path.join(CHROME_LIGHT_DIR, "icons"), { recursive: true });
  for (const icon of iconFiles) {
    fs.copyFileSync(
      path.join(ADDON_LIGHT_DIR, icon),
      path.join(CHROME_LIGHT_DIR, icon)
    );
  }

  // Generate Chrome Dark and Light toolbar images with droplet.io Pink (#ff00b8) -> Berry (#ac00d7) cap
  fs.mkdirSync(path.join(CHROME_DARK_DIR, "images"), { recursive: true });
  fs.writeFileSync(
    path.join(CHROME_DARK_DIR, "images", "theme_toolbar.png"),
    createToolbarPng({
      capStart: [255, 0, 184, 255],         // #ff00b8 (--magenta on droplet.io)
      capEnd: [172, 0, 215, 255],           // #ac00d7 (--berry on droplet.io)
      transitionColor: [97, 9, 153, 255],   // #610999
      tabTopColor: [22, 18, 92, 255],       // #16125c
      toolbarColor: [11, 13, 61, 255],      // #0b0d3d
    })
  );

  fs.mkdirSync(path.join(CHROME_LIGHT_DIR, "images"), { recursive: true });
  fs.writeFileSync(
    path.join(CHROME_LIGHT_DIR, "images", "theme_toolbar.png"),
    createToolbarPng({
      capStart: [255, 0, 184, 255],          // #ff00b8 (--magenta on droplet.io)
      capEnd: [172, 0, 215, 255],            // #ac00d7 (--berry on droplet.io)
      transitionColor: [235, 165, 232, 255], // #eba5e8
      tabTopColor: [255, 255, 255, 255],     // #ffffff (--white on droplet.io)
      toolbarColor: [250, 250, 250, 255],    // #fafafa (--light-grey on droplet.io)
    })
  );

  // Remove any stale Chrome cached theme packs so unpacked reloads pick up changes
  fs.rmSync(path.join(CHROME_DARK_DIR, "Cached Theme.pak"), { force: true });
  fs.rmSync(path.join(CHROME_LIGHT_DIR, "Cached Theme.pak"), { force: true });

  const addonFiles = ["manifest.json", ...iconFiles];
  const chromeAddonFiles = ["manifest.json", ...iconFiles, "images"];

  // Output paths across Firefox and Chrome for Dark & Light
  const ffDarkXpiPath = path.join(BUILD_DIR, "droplet-firefox-theme-dark.xpi");
  const ffDarkZipPath = path.join(BUILD_DIR, "droplet-firefox-theme-dark.zip");
  const ffLightXpiPath = path.join(BUILD_DIR, "droplet-firefox-theme-light.xpi");
  const ffLightZipPath = path.join(BUILD_DIR, "droplet-firefox-theme-light.zip");

  const chromeDarkZipPath = path.join(BUILD_DIR, "droplet-chrome-theme-dark.zip");
  const chromeLightZipPath = path.join(BUILD_DIR, "droplet-chrome-theme-light.zip");

  // Package Firefox Dark & Light (.xpi and .zip)
  execFileSync("zip", ["-q", "-r", ffDarkXpiPath, ...addonFiles], { cwd: ADDON_DARK_DIR });
  fs.copyFileSync(ffDarkXpiPath, ffDarkZipPath);

  execFileSync("zip", ["-q", "-r", ffLightXpiPath, ...addonFiles], { cwd: ADDON_LIGHT_DIR });
  fs.copyFileSync(ffLightXpiPath, ffLightZipPath);

  // Package Chrome Dark & Light (.zip)
  execFileSync("zip", ["-q", "-r", chromeDarkZipPath, ...chromeAddonFiles], { cwd: CHROME_DARK_DIR });
  execFileSync("zip", ["-q", "-r", chromeLightZipPath, ...chromeAddonFiles], { cwd: CHROME_LIGHT_DIR });

  console.log("✅ Built Droplet Firefox Add-on packages (Dark & Light):");
  console.log(`   - ${path.relative(ROOT_DIR, ffDarkXpiPath)} & ${path.relative(ROOT_DIR, ffDarkZipPath)}`);
  console.log(`   - ${path.relative(ROOT_DIR, ffLightXpiPath)} & ${path.relative(ROOT_DIR, ffLightZipPath)}`);
  console.log("✅ Built Droplet Chrome Web Store packages (Dark & Light):");
  console.log(`   - ${path.relative(ROOT_DIR, chromeDarkZipPath)}`);
  console.log(`   - ${path.relative(ROOT_DIR, chromeLightZipPath)}`);
}

build();
