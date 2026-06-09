// ============================================================
// Procedural texture generation.
// Every texture (terrain atlas, cracks, sun, moon, clouds,
// water) is painted pixel-by-pixel into canvases at startup —
// the game ships zero image assets, just like-the-real-thing
// 16x16 pixel art generated from seeded PRNGs.
// ============================================================

import { mulberry32, hashString } from './noise.js';

export const TILE_SIZE = 16;
export const ATLAS_COLS = 16;

// ------------------------------------------------------------
// Tiny pixel buffer helper
// ------------------------------------------------------------

class Px {
  constructor(w = TILE_SIZE, h = TILE_SIZE) {
    this.w = w;
    this.h = h;
    this.d = new Uint8ClampedArray(w * h * 4);
  }
  set(x, y, rgb, a = 255) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.d[i] = rgb[0]; this.d[i + 1] = rgb[1]; this.d[i + 2] = rgb[2]; this.d[i + 3] = a;
  }
  get(x, y) {
    const i = (y * this.w + x) * 4;
    return [this.d[i], this.d[i + 1], this.d[i + 2], this.d[i + 3]];
  }
}

const mul = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
const lum = (rng, amt) => 1 + (rng() - 0.5) * 2 * amt;

/** Fill the whole tile with a base color whose luminance jitters per pixel. */
function noiseFill(px, rng, base, amt = 0.1) {
  for (let y = 0; y < px.h; y++)
    for (let x = 0; x < px.w; x++)
      px.set(x, y, mul(base, lum(rng, amt)));
}

/** Sprinkle n single pixels of a color. */
function speckle(px, rng, color, n, a = 255) {
  for (let i = 0; i < n; i++)
    px.set((rng() * px.w) | 0, (rng() * px.h) | 0, color, a);
}

/** Small irregular blob around a center. */
function blob(px, rng, cx, cy, r, color, amt = 0.08) {
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++)
      if (x * x + y * y <= r * r + rng() * 1.5)
        px.set(cx + x, cy + y, mul(color, lum(rng, amt)));
}

// ------------------------------------------------------------
// Tile painters — name -> fn(px, rng)
// ------------------------------------------------------------

const C = {
  grass:        [110, 178, 72],
  grassForest:  [82, 153, 58],
  dirt:         [134, 96, 67],
  dirtDark:     [101, 67, 33],
  dirtLight:    [155, 118, 83],
  stone:        [127, 127, 127],
  sand:         [218, 207, 160],
  snow:         [240, 246, 250],
  waterDeep:    [44, 86, 200],
  bark:         [107, 84, 51],
  barkDark:     [80, 62, 36],
  sprucebark:   [74, 57, 35],
  wood:         [168, 133, 82],
  leaves:       [58, 126, 34],
  leavesSpruce: [44, 96, 60],
};

function paintGrassTop(base) {
  return (px, rng) => {
    noiseFill(px, rng, base, 0.1);
    speckle(px, rng, mul(base, 0.78), 26);
    speckle(px, rng, mul(base, 1.18), 14);
  };
}

function paintDirt(px, rng) {
  noiseFill(px, rng, C.dirt, 0.1);
  speckle(px, rng, C.dirtDark, 24);
  speckle(px, rng, C.dirtLight, 12);
}

function paintGrassSide(snowy) {
  return (px, rng) => {
    paintDirt(px, rng);
    const top = snowy ? C.snow : C.grass;
    for (let x = 0; x < 16; x++) {
      const depth = 2 + ((rng() * 2.4) | 0); // jagged grass rim
      for (let y = 0; y < depth; y++) px.set(x, y, mul(top, lum(rng, 0.1)));
      if (!snowy) px.set(x, depth, mul(C.grass, 0.62));
    }
  };
}

function paintStone(px, rng) {
  noiseFill(px, rng, C.stone, 0.07);
  // short horizontal darker streaks for that classic stone look
  for (let i = 0; i < 9; i++) {
    const x = (rng() * 14) | 0, y = (rng() * 16) | 0, len = 2 + ((rng() * 3) | 0);
    for (let k = 0; k < len; k++) px.set(x + k, y, mul(C.stone, 0.82 + rng() * 0.06));
  }
  speckle(px, rng, mul(C.stone, 1.16), 8);
}

function paintCobble(px, rng) {
  // jittered voronoi cells -> rounded stones with dark mortar
  const seeds = [];
  for (let gy = 0; gy < 4; gy++)
    for (let gx = 0; gx < 4; gx++)
      seeds.push({
        x: gx * 4 + 1 + rng() * 2.4,
        y: gy * 4 + 1 + rng() * 2.4,
        f: 0.74 + rng() * 0.42,
      });
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let d1 = 1e9, d2 = 1e9, s1 = null;
      for (const s of seeds) {
        // toroidal distance so the texture tiles seamlessly
        let dx = Math.abs(x - s.x); if (dx > 8) dx = 16 - dx;
        let dy = Math.abs(y - s.y); if (dy > 8) dy = 16 - dy;
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; s1 = s; } else if (d < d2) d2 = d;
      }
      const edge = Math.sqrt(d2) - Math.sqrt(d1);
      if (edge < 0.9) px.set(x, y, mul([64, 64, 64], lum(rng, 0.08)));
      else px.set(x, y, mul([128, 128, 128], s1.f * lum(rng, 0.06)));
    }
  }
}

function paintBedrock(px, rng) {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const r = rng();
      const c = r < 0.34 ? [38, 38, 38] : r < 0.7 ? [85, 85, 85] : [129, 129, 129];
      px.set(x, y, mul(c, lum(rng, 0.05)));
    }
}

function paintSand(px, rng) {
  noiseFill(px, rng, C.sand, 0.06);
  speckle(px, rng, mul(C.sand, 0.85), 14);
  speckle(px, rng, mul(C.sand, 1.1), 8);
}

function paintGravel(px, rng) {
  noiseFill(px, rng, [129, 121, 112], 0.09);
  for (let i = 0; i < 13; i++) {
    const shade = 0.72 + rng() * 0.62;
    blob(px, rng, (rng() * 16) | 0, (rng() * 16) | 0, 1 + (rng() * 1.4) | 0, mul([135, 127, 118], shade));
  }
}

function paintLogSide(bark, dark) {
  return (px, rng) => {
    for (let x = 0; x < 16; x++) {
      const f = 0.82 + rng() * 0.36;
      for (let y = 0; y < 16; y++) px.set(x, y, mul(bark, f * lum(rng, 0.07)));
    }
    for (let i = 0; i < 12; i++) px.set((rng() * 16) | 0, (rng() * 16) | 0, mul(dark, lum(rng, 0.1)));
    for (let y = 0; y < 16; y++) { px.set(0, y, mul(dark, 0.95)); px.set(15, y, mul(dark, 0.95)); }
  };
}

function paintLogTop(bark) {
  return (px, rng) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const ring = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)) | 0;
        if (ring >= 6) px.set(x, y, mul(bark, lum(rng, 0.08)));
        else px.set(x, y, mul(ring % 2 === 0 ? [178, 142, 90] : [148, 113, 64], lum(rng, 0.05)));
      }
  };
}

function paintPlanks(px, rng) {
  const boardShade = [1, 0.93, 1.04, 0.9];
  for (let y = 0; y < 16; y++) {
    const board = (y / 4) | 0;
    for (let x = 0; x < 16; x++) {
      if (y % 4 === 3) { px.set(x, y, mul([94, 72, 42], lum(rng, 0.06))); continue; }
      px.set(x, y, mul(C.wood, boardShade[board] * lum(rng, 0.07)));
    }
  }
  // vertical seams per board + nail dots
  for (let board = 0; board < 4; board++) {
    const sx = (hashStringToInt('seam' + board) % 16);
    for (let y = board * 4; y < board * 4 + 3; y++) px.set(sx, y, mul([94, 72, 42], 1.05));
  }
}

function hashStringToInt(s) { return hashString(s) >>> 8; }

function paintLeaves(base) {
  return (px, rng) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        if (rng() < 0.13) { px.set(x, y, [0, 0, 0], 0); continue; } // holes
        const f = rng() < 0.18 ? 1.3 : 1;
        px.set(x, y, mul(base, f * lum(rng, 0.16)));
      }
  };
}

function paintGlass(px, rng) {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) px.set(x, y, [255, 255, 255], 0);
  const b = [215, 235, 240];
  for (let i = 0; i < 16; i++) {
    px.set(i, 0, b); px.set(i, 15, b); px.set(0, i, b); px.set(15, i, b);
  }
  for (let i = 2; i < 7; i++) px.set(i, 9 - i, [255, 255, 255], 175); // streak
  for (let i = 4; i < 10; i++) px.set(i, 16 - i, [255, 255, 255], 120);
}

function paintSnow(px, rng) { noiseFill(px, rng, C.snow, 0.035); }

function paintIce(px, rng) {
  noiseFill(px, rng, [145, 183, 235], 0.05);
  for (let i = 0; i < 4; i++) {
    let x = (rng() * 16) | 0, y = (rng() * 16) | 0;
    for (let k = 0; k < 5; k++) { px.set(x, y, [210, 230, 255]); x += 1; y += rng() < 0.5 ? 1 : 0; }
  }
}

function paintWaterStill(px, rng) {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const s = Math.sin((x * 2 / 16) * Math.PI * 2 + (y / 16) * Math.PI * 4);
      const c = s > 0.55 ? [72, 118, 232] : s < -0.6 ? [36, 70, 180] : C.waterDeep;
      px.set(x, y, mul(c, lum(rng, 0.04)));
    }
}

function paintBricks(px, rng) {
  for (let y = 0; y < 16; y++) {
    const row = (y / 4) | 0;
    for (let x = 0; x < 16; x++) {
      const mortarH = y % 4 === 3;
      const off = row % 2 === 0 ? 0 : 4;
      const mortarV = (x + off) % 8 === 7;
      if (mortarH || mortarV) { px.set(x, y, mul([167, 162, 156], lum(rng, 0.05))); continue; }
      const brickId = row * 31 + (((x + off) / 8) | 0);
      const f = 0.85 + (hashStringToInt('brick' + brickId) % 100) / 320;
      px.set(x, y, mul([150, 84, 66], f * lum(rng, 0.05)));
    }
  }
}

function paintStoneBrick(px, rng) {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const edge = x % 8 === 7 || y % 8 === 7;
      if (edge) { px.set(x, y, mul([66, 66, 66], lum(rng, 0.06))); continue; }
      const hi = x % 8 === 0 || y % 8 === 0;
      px.set(x, y, mul([122, 122, 122], (hi ? 1.16 : 1) * lum(rng, 0.06)));
    }
  for (let i = 0; i < 5; i++) px.set((rng() * 16) | 0, (rng() * 16) | 0, [80, 80, 80]);
}

function paintBookshelf(px, rng) {
  paintPlanks(px, rng);
  const spineColors = [
    [160, 60, 50], [60, 90, 160], [70, 130, 60], [150, 120, 50], [120, 70, 140], [200, 180, 140],
  ];
  for (const rowTop of [2, 9]) {
    for (let y = rowTop; y < rowTop + 5; y++)
      for (let x = 1; x < 15; x++) px.set(x, y, [38, 28, 18]);
    let x = 1;
    while (x < 15) {
      const w = rng() < 0.4 ? 2 : 1;
      const c = spineColors[(rng() * spineColors.length) | 0];
      for (let k = 0; k < w && x + k < 15; k++)
        for (let y = rowTop; y < rowTop + 5; y++)
          px.set(x + k, y, mul(c, (y === rowTop ? 1.2 : 1) * lum(rng, 0.06)));
      x += w + (rng() < 0.25 ? 1 : 0); // occasional gap
    }
  }
}

const TNT_LETTERS = {
  T: [[1, 1, 1], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]],
  N: [[1, 0, 1], [1, 1, 1], [1, 1, 1], [1, 0, 1], [1, 0, 1]],
};

function paintTntSide(px, rng) {
  noiseFill(px, rng, [219, 68, 26], 0.07);
  for (let y = 5; y <= 9; y++)
    for (let x = 0; x < 16; x++) px.set(x, y, mul([229, 229, 229], lum(rng, 0.04)));
  const word = ['T', 'N', 'T'];
  word.forEach((ch, i) => {
    const glyph = TNT_LETTERS[ch];
    const ox = 2 + i * 4;
    for (let gy = 0; gy < 5; gy++)
      for (let gx = 0; gx < 3; gx++)
        if (glyph[gy][gx]) px.set(ox + gx, 5 + gy, [42, 30, 28]);
  });
}

function paintTntTop(px, rng) {
  noiseFill(px, rng, [216, 170, 108], 0.06);
  for (let i = 0; i < 16; i++) {
    for (const [x, y] of [[i, 0], [i, 15], [0, i], [15, i], [i, 1], [i, 14], [1, i], [14, i]])
      px.set(x, y, mul([219, 68, 26], lum(rng, 0.06)));
  }
  for (let gy = 0; gy < 3; gy++)
    for (let gx = 0; gx < 3; gx++)
      blob(px, rng, 4 + gx * 4, 4 + gy * 4, 1, [150, 44, 22], 0.05);
}

function paintTntBottom(px, rng) {
  noiseFill(px, rng, [216, 170, 108], 0.06);
  for (let i = 0; i < 16; i++)
    for (const [x, y] of [[i, 0], [i, 15], [0, i], [15, i]])
      px.set(x, y, mul([219, 68, 26], lum(rng, 0.06)));
}

function paintPumpkinSide(face) {
  return (px, rng) => {
    for (let x = 0; x < 16; x++) {
      const rib = x % 4;
      const f = rib === 0 ? 0.8 : rib === 2 ? 1.1 : 1;
      for (let y = 0; y < 16; y++) px.set(x, y, mul([192, 118, 21], f * lum(rng, 0.06)));
    }
    if (face) {
      const dark = [45, 28, 8];
      // eyes
      for (const ox of [3, 10]) {
        px.set(ox + 1, 4, dark);
        for (let x = ox; x < ox + 3; x++) px.set(x, 5, dark);
        for (let x = ox; x < ox + 3; x++) px.set(x, 6, dark);
      }
      px.set(7, 7, dark); px.set(8, 7, dark); // nose
      // zigzag mouth
      const mouth = [[2, 10], [3, 11], [4, 10], [5, 11], [6, 12], [7, 11], [8, 11], [9, 12], [10, 11], [11, 10], [12, 11], [13, 10]];
      for (const [x, y] of mouth) { px.set(x, y, dark); px.set(x, y + 1, dark); }
    }
  };
}

function paintPumpkinTop(px, rng) {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const ring = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)) | 0;
      px.set(x, y, mul([196, 126, 30], (ring % 2 ? 0.92 : 1.05) * lum(rng, 0.05)));
    }
  blob(px, rng, 8, 8, 1, [96, 110, 34], 0.08); // stem
}

function paintCactusSide(px, rng) {
  for (let x = 0; x < 16; x++) {
    const rib = x % 4;
    const f = rib === 1 ? 1.15 : rib === 3 ? 0.78 : 1;
    for (let y = 0; y < 16; y++) px.set(x, y, mul([58, 113, 35], f * lum(rng, 0.07)));
  }
  for (let i = 0; i < 7; i++) px.set((rng() * 16) | 0, (rng() * 16) | 0, [225, 245, 210]); // spines
  for (let y = 0; y < 16; y++) { px.set(0, y, mul([42, 84, 26], 1)); px.set(15, y, mul([42, 84, 26], 1)); }
}

function paintCactusTop(px, rng) {
  noiseFill(px, rng, [70, 130, 42], 0.06);
  for (let i = 0; i < 16; i++)
    for (const [x, y] of [[i, 0], [i, 15], [0, i], [15, i]]) px.set(x, y, [46, 92, 28]);
  blob(px, rng, 8, 8, 2, [88, 152, 56], 0.06);
}

function paintOre(oreColor, hiColor, clusters = 5) {
  return (px, rng) => {
    paintStone(px, rng);
    for (let i = 0; i < clusters; i++) {
      const cx = 2 + ((rng() * 12) | 0), cy = 2 + ((rng() * 12) | 0);
      const n = 2 + ((rng() * 4) | 0);
      for (let k = 0; k < n; k++) {
        const x = cx + ((rng() * 3) | 0) - 1, y = cy + ((rng() * 3) | 0) - 1;
        px.set(x, y, mul(oreColor, lum(rng, 0.08)));
        if (rng() < 0.4) px.set(x + 1, y, mul(hiColor, lum(rng, 0.06)));
      }
    }
  };
}

function paintObsidian(px, rng) {
  noiseFill(px, rng, [24, 16, 38], 0.12);
  for (let i = 0; i < 7; i++)
    blob(px, rng, (rng() * 16) | 0, (rng() * 16) | 0, 1 + (rng() * 1.6 | 0), [52, 34, 82], 0.1);
  speckle(px, rng, [98, 70, 145], 6);
}

function transparentFill(px) {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) px.set(x, y, [0, 0, 0], 0);
}

function paintFlower(headColor, headDark) {
  return (px, rng) => {
    transparentFill(px);
    for (let y = 8; y <= 15; y++) px.set(y % 2 === 0 ? 8 : 7, y, mul([62, 140, 42], lum(rng, 0.1)));
    px.set(6, 12, [62, 140, 42]); px.set(9, 11, [70, 150, 46]); // leaves
    for (let y = 4; y <= 7; y++)
      for (let x = 6; x <= 9; x++)
        if (!((x === 6 || x === 9) && (y === 4 || y === 7)))
          px.set(x, y, mul(headColor, lum(rng, 0.08)));
    px.set(7, 5, headDark); px.set(8, 6, headDark);
  };
}

function paintTallgrass(px, rng) {
  transparentFill(px);
  for (let i = 0; i < 7; i++) {
    let x = 2 + ((rng() * 12) | 0);
    const h = 6 + ((rng() * 6) | 0);
    for (let y = 15; y > 15 - h; y--) {
      px.set(x, y, mul([88, 152, 62], lum(rng, 0.14)));
      if (rng() < 0.3) x += rng() < 0.5 ? 1 : -1;
    }
  }
}

function paintDeadbush(px, rng) {
  transparentFill(px);
  for (let y = 9; y <= 15; y++) px.set(8, y, mul([122, 91, 50], lum(rng, 0.08)));
  const branches = [[7, 9, -1, -1], [9, 9, 1, -1], [8, 11, -1, -1], [8, 12, 1, -1]];
  for (const [bx, by, dx, dy] of branches) {
    let x = bx, y = by;
    for (let k = 0; k < 3 + ((rng() * 2) | 0); k++) {
      px.set(x, y, mul([122, 91, 50], lum(rng, 0.1)));
      x += rng() < 0.7 ? dx : 0; y += dy;
    }
  }
}

function paintTorch(px, rng) {
  transparentFill(px);
  for (let y = 6; y <= 15; y++) {
    px.set(7, y, mul([110, 82, 48], lum(rng, 0.07)));
    px.set(8, y, mul([95, 70, 40], lum(rng, 0.07)));
  }
  px.set(7, 5, [255, 216, 81]); px.set(8, 5, [255, 216, 81]);
  px.set(7, 4, [255, 245, 180]); px.set(8, 4, [255, 233, 120]);
}

// ------------------------------------------------------------
// Painter registry — order defines atlas layout
// ------------------------------------------------------------

export const PAINTERS = {
  grass_top: paintGrassTop(C.grass),
  grass_top_forest: paintGrassTop(C.grassForest),
  grass_side: paintGrassSide(false),
  grass_side_snow: paintGrassSide(true),
  dirt: paintDirt,
  stone: paintStone,
  cobble: paintCobble,
  bedrock: paintBedrock,
  sand: paintSand,
  sandstone_top: (px, rng) => { noiseFill(px, rng, mul(C.sand, 1.02), 0.04); },
  sandstone_side: (px, rng) => {
    for (let y = 0; y < 16; y++) {
      const f = y < 2 ? 1.08 : [1, 0.97, 0.92, 0.97][y % 4];
      for (let x = 0; x < 16; x++) px.set(x, y, mul(C.sand, f * lum(rng, 0.045)));
    }
    speckle(px, rng, mul(C.sand, 0.8), 10);
  },
  gravel: paintGravel,
  log_side: paintLogSide(C.bark, C.barkDark),
  log_top: paintLogTop(C.bark),
  spruce_log_side: paintLogSide(C.sprucebark, [52, 40, 24]),
  spruce_log_top: paintLogTop(C.sprucebark),
  planks: paintPlanks,
  leaves: paintLeaves(C.leaves),
  leaves_spruce: paintLeaves(C.leavesSpruce),
  glass: paintGlass,
  snow: paintSnow,
  ice: paintIce,
  water_still: paintWaterStill,
  bricks: paintBricks,
  stonebrick: paintStoneBrick,
  bookshelf: paintBookshelf,
  tnt_side: paintTntSide,
  tnt_top: paintTntTop,
  tnt_bottom: paintTntBottom,
  pumpkin_side: paintPumpkinSide(false),
  pumpkin_face: paintPumpkinSide(true),
  pumpkin_top: paintPumpkinTop,
  cactus_side: paintCactusSide,
  cactus_top: paintCactusTop,
  coal_ore: paintOre([47, 47, 47], [88, 88, 88]),
  iron_ore: paintOre([216, 175, 147], [240, 202, 172]),
  gold_ore: paintOre([252, 238, 75], [255, 255, 160], 4),
  diamond_ore: paintOre([98, 237, 228], [185, 255, 250], 4),
  redstone_ore: paintOre([255, 60, 60], [255, 140, 140], 4),
  obsidian: paintObsidian,
  flower_red: paintFlower([200, 44, 44], [120, 16, 16]),
  flower_yellow: paintFlower([232, 222, 74], [170, 140, 30]),
  tallgrass: paintTallgrass,
  deadbush: paintDeadbush,
  torch: paintTorch,
};

export const TILE_NAMES = Object.keys(PAINTERS);
const TILE_INDEX = new Map(TILE_NAMES.map((n, i) => [n, i]));
export const ATLAS_ROWS = Math.ceil(TILE_NAMES.length / ATLAS_COLS);

/**
 * UV rect for a tile (pure math — usable in node tests).
 * Accounts for canvas-texture flipY: v=0 is the canvas bottom.
 * A small epsilon inset avoids sampling neighbor tiles.
 */
export function atlasUV(name) {
  const idx = TILE_INDEX.get(name);
  if (idx === undefined) throw new Error('unknown tile: ' + name);
  const col = idx % ATLAS_COLS;
  const row = (idx / ATLAS_COLS) | 0;
  const tw = 1 / ATLAS_COLS, th = 1 / ATLAS_ROWS;
  const e = 0.0012;
  return {
    u0: col * tw + e * tw,
    v0: 1 - (row + 1) * th + e * th,
    u1: (col + 1) * tw - e * tw,
    v1: 1 - row * th - e * th,
  };
}

// ------------------------------------------------------------
// Browser-side canvas builders
// ------------------------------------------------------------

function paintTile(name) {
  const px = new Px();
  const rng = mulberry32(hashString('tile:' + name));
  PAINTERS[name](px, rng);
  return px;
}

export function buildAtlasCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * TILE_SIZE;
  canvas.height = ATLAS_ROWS * TILE_SIZE;
  const ctx = canvas.getContext('2d');
  TILE_NAMES.forEach((name, idx) => {
    const px = paintTile(name);
    const img = new ImageData(px.d, TILE_SIZE, TILE_SIZE);
    ctx.putImageData(img, (idx % ATLAS_COLS) * TILE_SIZE, ((idx / ATLAS_COLS) | 0) * TILE_SIZE);
  });
  return canvas;
}

/** Flat (non-isometric) icon for cross-shaped blocks & liquids. */
export function tileIconCanvas(name, size = 64) {
  const src = document.createElement('canvas');
  src.width = src.height = TILE_SIZE;
  src.getContext('2d').putImageData(new ImageData(paintTile(name).d, TILE_SIZE, TILE_SIZE), 0, 0);
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, size, size);
  return out;
}

/** 8 destroy-stage crack overlays. */
export function buildCrackCanvases() {
  const out = [];
  for (let stage = 0; stage < 8; stage++) {
    const px = new Px();
    transparentFill(px);
    const rng = mulberry32(hashString('crack' + stage) ^ 0x9e3779b9);
    const walks = 3 + stage;
    for (let w = 0; w < walks; w++) {
      let x = 5 + ((rng() * 6) | 0), y = 5 + ((rng() * 6) | 0);
      const len = 4 + stage * 1.6;
      let dx = rng() < 0.5 ? 1 : -1, dy = rng() < 0.5 ? 1 : -1;
      for (let k = 0; k < len; k++) {
        px.set(x, y, [22, 22, 22], 150 + stage * 12);
        if (rng() < 0.55) x += dx; else y += dy;
        if (rng() < 0.16) dx = -dx;
        if (rng() < 0.16) dy = -dy;
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = TILE_SIZE;
    canvas.getContext('2d').putImageData(new ImageData(px.d, TILE_SIZE, TILE_SIZE), 0, 0);
    out.push(canvas);
  }
  return out;
}

/** Animated water surface texture (separate from the atlas, world-tiled). */
export function buildWaterCanvas() {
  const S = 32;
  const px = new Px(S, S);
  const rng = mulberry32(hashString('water-anim'));
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      // sums of sines with periods dividing S => seamless tiling
      const a = Math.sin((x * 2 + y * 1) * Math.PI * 2 / S);
      const b = Math.sin((x * 1 - y * 3) * Math.PI * 2 / S + 1.7);
      const s = a + b;
      const c = s > 0.9 ? [82, 128, 240] : s < -1.0 ? [30, 62, 168] : C.waterDeep;
      px.set(x, y, mul(c, lum(rng, 0.04)));
    }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  canvas.getContext('2d').putImageData(new ImageData(px.d, S, S), 0, 0);
  return canvas;
}

export function buildSunCanvas() {
  const S = 32;
  const px = new Px(S, S);
  const rng = mulberry32(1);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const edge = Math.max(Math.abs(x - 15.5), Math.abs(y - 15.5));
      const c = edge > 13 ? [255, 226, 120] : [255, 250, 190];
      px.set(x, y, mul(c, lum(rng, 0.02)));
    }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  canvas.getContext('2d').putImageData(new ImageData(px.d, S, S), 0, 0);
  return canvas;
}

export function buildMoonCanvas() {
  const S = 32;
  const px = new Px(S, S);
  const rng = mulberry32(2);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++)
      px.set(x, y, mul([214, 218, 228], lum(rng, 0.04)));
  for (let i = 0; i < 7; i++)
    blob(px, rng, (rng() * S) | 0, (rng() * S) | 0, 1 + ((rng() * 2) | 0), [168, 172, 188], 0.06);
  // subtle phase shadow on the right edge
  for (let y = 0; y < S; y++)
    for (let x = 26; x < S; x++) px.set(x, y, mul([150, 154, 170], lum(rng, 0.05)));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  canvas.getContext('2d').putImageData(new ImageData(px.d, S, S), 0, 0);
  return canvas;
}

/** Blocky Minecraft-style cloud layer texture (1 px = 8 world units). */
export function buildCloudCanvas() {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  const rng = mulberry32(hashString('clouds'));
  // low-res value noise lattice, bilinear interpolation, hard threshold
  const L = 16, lat = [];
  for (let i = 0; i < (L + 1) * (L + 1); i++) lat.push(rng());
  const latAt = (x, y) => lat[(y % L) * (L + 1) + (x % L)];
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const gx = x / (S / L), gy = y / (S / L);
      const x0 = gx | 0, y0 = gy | 0, fx = gx - x0, fy = gy - y0;
      const v =
        latAt(x0, y0) * (1 - fx) * (1 - fy) + latAt(x0 + 1, y0) * fx * (1 - fy) +
        latAt(x0, y0 + 1) * (1 - fx) * fy + latAt(x0 + 1, y0 + 1) * fx * fy;
      const on = v > 0.62;
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = on ? 255 : 0;
    }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
