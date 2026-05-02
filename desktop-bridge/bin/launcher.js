const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const zlib = require("zlib");

const APP_NAME = "Vlix";
const APP_BUNDLE_ID = "app.vlix.bridge";

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
};

const mix = (from, to, amount) => Math.round(from + (to - from) * amount);

const distToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
};

const roundedRectAlpha = (x, y, left, top, right, bottom, radius) => {
  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  const distance = Math.hypot(x - cx, y - cy);
  return distance <= radius ? 1 : 0;
};

const createIconPng = (size) => {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const inset = size * 0.08;
  const left = inset;
  const top = inset;
  const right = size - inset;
  const bottom = size - inset;
  const radius = size * 0.2;
  const cyan = [49, 220, 255];
  const violet = [139, 92, 246];
  const stroke = size * 0.105;
  const samples = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];

  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      let rectCoverage = 0;
      let markCoverage = 0;
      for (const [sx, sy] of samples) {
        const px = x + sx;
        const py = y + sy;
        rectCoverage += roundedRectAlpha(px, py, left, top, right, bottom, radius);
        const npx = px / size;
        const npy = py / size;
        const leftStroke = distToSegment(npx, npy, 0.31, 0.34, 0.5, 0.69);
        const rightStroke = distToSegment(npx, npy, 0.69, 0.34, 0.5, 0.69);
        if (Math.min(leftStroke, rightStroke) < stroke / size / 2) markCoverage += 1;
      }
      const alpha = rectCoverage / samples.length;
      const markAlpha = markCoverage / samples.length;
      const gradient = Math.max(0, Math.min(1, (x / size) * 0.78 + (y / size) * 0.22));
      const base = [
        mix(cyan[0], violet[0], gradient),
        mix(cyan[1], violet[1], gradient),
        mix(cyan[2], violet[2], gradient),
      ];
      const offset = row + 1 + x * 4;
      raw[offset] = mix(base[0], 6, markAlpha);
      raw[offset + 1] = mix(base[1], 8, markAlpha);
      raw[offset + 2] = mix(base[2], 10, markAlpha);
      raw[offset + 3] = Math.round(alpha * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

const plist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${APP_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.13</string>
</dict>
</plist>
`;

const launcherScript = () => `#!/bin/zsh
export OPEN_ON_START=1
export VLIX_SKIP_LAUNCHER_INSTALL=1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
exec npx --yes vlix-install@latest
`;

const writeMacIcon = (resourcesDir) => {
  const iconset = path.join(resourcesDir, "AppIcon.iconset");
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  const icons = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];
  for (const [name, size] of icons) {
    fs.writeFileSync(path.join(iconset, name), createIconPng(size));
  }
  const icns = path.join(resourcesDir, "AppIcon.icns");
  const result = spawnSync("iconutil", ["-c", "icns", iconset, "-o", icns], {
    stdio: "ignore",
  });
  fs.rmSync(iconset, { recursive: true, force: true });
  return result.status === 0 && fs.existsSync(icns);
};

const installMacLauncher = () => {
  const applicationsDir = path.join(os.homedir(), "Applications");
  const appDir = path.join(applicationsDir, `${APP_NAME}.app`);
  const contentsDir = path.join(appDir, "Contents");
  const macOsDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");
  fs.mkdirSync(macOsDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(path.join(contentsDir, "Info.plist"), plist());
  const executable = path.join(macOsDir, APP_NAME);
  fs.writeFileSync(executable, launcherScript());
  fs.chmodSync(executable, 0o755);
  const hasIcon = writeMacIcon(resourcesDir);
  console.log(
    `Vlix launcher installed at ${appDir}${hasIcon ? "" : " (icon generation skipped)"}`,
  );
};

const installWindowsLauncher = () => {
  const startMenu = process.env.APPDATA
    ? path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")
    : "";
  if (!startMenu) return;
  fs.mkdirSync(startMenu, { recursive: true });
  const script = path.join(startMenu, "Vlix.cmd");
  fs.writeFileSync(
    script,
    `@echo off\r\nset OPEN_ON_START=1\r\nset VLIX_SKIP_LAUNCHER_INSTALL=1\r\nnpx --yes vlix-install@latest\r\n`,
  );
  console.log(`Vlix launcher installed at ${script}`);
};

const installLauncher = () => {
  if (process.env.VLIX_SKIP_LAUNCHER_INSTALL === "1") return;
  try {
    if (process.platform === "darwin") installMacLauncher();
    else if (process.platform === "win32") installWindowsLauncher();
  } catch (error) {
    console.warn(`Vlix launcher install skipped: ${error.message}`);
  }
};

module.exports = { installLauncher };
