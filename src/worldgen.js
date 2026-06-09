// ============================================================
// Terrain generation: continents, hills, ridged mountains,
// temperature/humidity biomes, beaches, oceans w/ ice, caves
// (trilinearly-interpolated 3D noise "spaghetti" + caverns),
// ore veins, trees, cacti, flowers and other decorations.
// Fully deterministic from the world seed.
// ============================================================

import { SimplexNoise, hash2, hash3, hf } from './noise.js';
import { B, BLOCKS } from './blocks.js';

// a block "counts" for the skylight heightmap if it is an opaque cube
// (leaves/logs/glass excluded so forests don't blacken the ground)
const COUNTS_HEIGHT = new Uint8Array(256);
for (const d of BLOCKS) if (d) COUNTS_HEIGHT[d.id] = d.countsHeight ? 1 : 0;

export const CHUNK = 16;       // chunk footprint (x, z)
export const WORLD_H = 128;    // world height
export const SEA = 62;         // sea level (top water block y)

export const BIOME = { PLAINS: 0, FOREST: 1, DESERT: 2, SNOWY: 3, MOUNTAINS: 4, OCEAN: 5 };
export const BIOME_NAMES = ['Plains', 'Forest', 'Desert', 'Snowy Tundra', 'Mountains', 'Ocean'];

const idx = (x, y, z) => x + (z << 4) + (y << 8); // x + z*16 + y*256

export class WorldGen {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.nContinent = new SimplexNoise(seed ^ 0x1a2b3c);
    this.nHills = new SimplexNoise(seed ^ 0x4d5e6f);
    this.nMountain = new SimplexNoise(seed ^ 0x71f3a5);
    this.nTemp = new SimplexNoise(seed ^ 0x9d2c1b);
    this.nHumid = new SimplexNoise(seed ^ 0xc4e7d8);
    this.nCaveA = new SimplexNoise(seed ^ 0x35f1e2);
    this.nCaveB = new SimplexNoise(seed ^ 0x68a4b7);
    this.nCavern = new SimplexNoise(seed ^ 0xfa1c39);
  }

  // ----------------------------------------------------------
  // Column-level info (height, biome, surface blocks)
  // ----------------------------------------------------------

  columnInfo(x, z) {
    const continental = this.nContinent.fbm2(x * 0.0018, z * 0.0018, 4);
    const hills = this.nHills.fbm2(x * 0.0085, z * 0.0085, 4);
    const mtnRaw = this.nMountain.noise2(x * 0.0032, z * 0.0032);
    const mtn = Math.min(1, Math.max(0, (mtnRaw - 0.28) / 0.55)); // 0..1 mountain mask

    let h = SEA + 4 + continental * 22 + hills * 7;
    if (mtn > 0) {
      const ridge = 1 - Math.abs(this.nHills.noise2(x * 0.012, z * 0.012));
      h += Math.pow(mtn, 1.5) * (30 + ridge * 22);
    }
    h = Math.round(Math.min(WORLD_H - 8, Math.max(10, h)));

    const temp = this.nTemp.fbm2(x * 0.0011, z * 0.0011, 3) - Math.max(0, h - SEA - 14) * 0.006;
    const humid = this.nHumid.fbm2(x * 0.0013, z * 0.0013, 3);

    let biome;
    if (h < SEA - 2) biome = BIOME.OCEAN;
    else if (mtn > 0.5 && h > SEA + 20) biome = BIOME.MOUNTAINS;
    else if (temp < -0.34) biome = BIOME.SNOWY;
    else if (temp > 0.3 && humid < -0.1) biome = BIOME.DESERT;
    else if (humid > 0.06) biome = BIOME.FOREST;
    else biome = BIOME.PLAINS;

    // surface / filler selection
    let surface = B.GRASS, filler = B.DIRT, fillerDepth = 3;
    switch (biome) {
      case BIOME.OCEAN:
        surface = h < SEA - 9 ? B.GRAVEL : B.SAND;
        filler = surface;
        break;
      case BIOME.DESERT:
        surface = B.SAND; filler = B.SAND; fillerDepth = 4;
        break;
      case BIOME.SNOWY:
        surface = B.SNOW_GRASS;
        break;
      case BIOME.MOUNTAINS:
        surface = h > 92 ? B.SNOW_BLOCK : h > 78 ? B.STONE : B.GRASS;
        filler = h > 78 ? B.STONE : B.DIRT;
        break;
    }
    // beaches
    if (biome !== BIOME.DESERT && biome !== BIOME.OCEAN && h >= SEA - 2 && h <= SEA + 1) {
      surface = B.SAND; filler = B.SAND;
    }

    return { h, biome, surface, filler, fillerDepth, temp, humid, mtn };
  }

  biomeAt(x, z) { return this.columnInfo(x, z).biome; }

  /** Spiral out from origin to find a dry spawn column. */
  findSpawn() {
    for (let r = 0; r < 64; r++) {
      for (let a = 0; a < Math.max(1, r * 8); a++) {
        const ang = (a / Math.max(1, r * 8)) * Math.PI * 2;
        const x = Math.round(Math.cos(ang) * r * 8);
        const z = Math.round(Math.sin(ang) * r * 8);
        const c = this.columnInfo(x, z);
        if (c.h >= SEA + 1 && c.biome !== BIOME.OCEAN) {
          return { x: x + 0.5, y: c.h + 1, z: z + 0.5 };
        }
      }
    }
    return { x: 0.5, y: SEA + 20, z: 0.5 };
  }

  // ----------------------------------------------------------
  // Chunk generation
  // ----------------------------------------------------------

  /**
   * Fills chunk.blocks (Uint8Array 16*16*128), chunk.heights and
   * chunk.biomes (Uint8Array 256 each). Deterministic.
   */
  generate(chunk) {
    const { cx, cz } = chunk;
    const blocks = chunk.blocks;
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const seed = this.seed;

    // -------- column cache (covers tree margin) --------
    const colCache = new Map();
    const col = (wx, wz) => {
      const key = (wx - x0 + 8) * 64 + (wz - z0 + 8);
      let c = colCache.get(key);
      if (!c) { c = this.columnInfo(wx, wz); colCache.set(key, c); }
      return c;
    };

    // -------- base terrain --------
    let maxH = 0;
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const wx = x0 + lx, wz = z0 + lz;
        const info = col(wx, wz);
        const h = info.h;
        if (h > maxH) maxH = h;
        chunk.biomes[lx + lz * CHUNK] = info.biome;

        for (let y = 0; y <= h; y++) {
          let id;
          if (y === 0) id = B.BEDROCK;
          else if (y <= 2 && hf(hash3(wx, y, wz, seed ^ 0xbed)) < 0.55) id = B.BEDROCK;
          else if (y === h) id = info.surface;
          else if (y > h - 1 - info.fillerDepth) id = info.filler;
          else id = B.STONE;
          // desert sandstone shelf so sand doesn't float over caves
          if (id === B.STONE && info.biome === BIOME.DESERT && y > h - 8) id = B.SANDSTONE;
          blocks[idx(lx, y, lz)] = id;
        }
        // water
        if (h < SEA) {
          for (let y = h + 1; y <= SEA; y++) blocks[idx(lx, y, lz)] = B.WATER;
          if (info.biome === BIOME.SNOWY || (info.temp < -0.3 && info.biome === BIOME.OCEAN)) {
            blocks[idx(lx, SEA, lz)] = B.ICE;
          }
        }
      }
    }

    // -------- ore veins (chunk-seeded random walks) --------
    const oreTypes = [
      { id: B.COAL_ORE, tries: 14, min: 12, max: 92, size: [5, 13] },
      { id: B.IRON_ORE, tries: 9, min: 6, max: 54, size: [4, 8] },
      { id: B.GOLD_ORE, tries: 3, min: 4, max: 30, size: [3, 6] },
      { id: B.REDSTONE_ORE, tries: 5, min: 4, max: 16, size: [4, 7] },
      { id: B.DIAMOND_ORE, tries: 3, min: 4, max: 13, size: [3, 5] },
    ];
    let oreSeed = hash2(cx, cz, seed ^ 0x09e1);
    const oreRand = () => { oreSeed = hash2(oreSeed, 0x6b43, seed); return oreSeed / 4294967296; };
    for (const ore of oreTypes) {
      for (let t = 0; t < ore.tries; t++) {
        let x = (oreRand() * CHUNK) | 0;
        let z = (oreRand() * CHUNK) | 0;
        let y = ore.min + ((oreRand() * (ore.max - ore.min)) | 0);
        const n = ore.size[0] + ((oreRand() * (ore.size[1] - ore.size[0] + 1)) | 0);
        for (let k = 0; k < n; k++) {
          if (x >= 0 && x < CHUNK && z >= 0 && z < CHUNK && y > 2 && y < WORLD_H) {
            const i = idx(x, y, z);
            if (blocks[i] === B.STONE) blocks[i] = ore.id;
          }
          const dir = (oreRand() * 6) | 0;
          if (dir === 0) x++; else if (dir === 1) x--;
          else if (dir === 2) z++; else if (dir === 3) z--;
          else if (dir === 4) y++; else y--;
        }
      }
    }

    // -------- caves: trilinear-interpolated 3D noise --------
    // Sample noise on a 4x4x4 lattice, interpolate per block (the same
    // trick Minecraft uses) — ~15x fewer noise evaluations.
    const P = 4;
    const GX = CHUNK / P + 1, GZ = CHUNK / P + 1;
    const GY = Math.ceil((maxH + 2) / P) + 1;
    const gridA = new Float32Array(GX * GY * GZ);
    const gridB = new Float32Array(GX * GY * GZ);
    const gridC = new Float32Array(GX * GY * GZ);
    const gi = (gx, gy, gz) => gx + gz * GX + gy * GX * GZ;
    for (let gy = 0; gy < GY; gy++)
      for (let gz = 0; gz < GZ; gz++)
        for (let gx = 0; gx < GX; gx++) {
          const wx = x0 + gx * P, wy = gy * P, wz = z0 + gz * P;
          const g = gi(gx, gy, gz);
          gridA[g] = this.nCaveA.noise3(wx * 0.017, wy * 0.026, wz * 0.017);
          gridB[g] = this.nCaveB.noise3(wx * 0.017, wy * 0.026, wz * 0.017);
          gridC[g] = this.nCavern.noise3(wx * 0.009, wy * 0.015, wz * 0.009);
        }
    const lerp = (a, b, t) => a + (b - a) * t;
    const sampleGrid = (grid, x, y, z) => {
      const gx = x / P, gy = y / P, gz = z / P;
      const x1 = gx | 0, y1 = gy | 0, z1 = gz | 0;
      const fx = gx - x1, fy = gy - y1, fz = gz - z1;
      const c000 = grid[gi(x1, y1, z1)], c100 = grid[gi(x1 + 1, y1, z1)];
      const c010 = grid[gi(x1, y1 + 1, z1)], c110 = grid[gi(x1 + 1, y1 + 1, z1)];
      const c001 = grid[gi(x1, y1, z1 + 1)], c101 = grid[gi(x1 + 1, y1, z1 + 1)];
      const c011 = grid[gi(x1, y1 + 1, z1 + 1)], c111 = grid[gi(x1 + 1, y1 + 1, z1 + 1)];
      return lerp(
        lerp(lerp(c000, c100, fx), lerp(c001, c101, fx), fz),
        lerp(lerp(c010, c110, fx), lerp(c011, c111, fx), fz),
        fy,
      );
    };

    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const info = col(x0 + lx, z0 + lz);
        const h = info.h;
        // don't pierce the floor of oceans/lakes
        const top = h <= SEA + 1 ? h - 4 : h;
        for (let y = 3; y <= top; y++) {
          const i = idx(lx, y, lz);
          const cur = blocks[i];
          if (cur === B.AIR || cur === B.WATER || cur === B.BEDROCK) continue;
          const a = sampleGrid(gridA, lx, y, lz);
          const b = sampleGrid(gridB, lx, y, lz);
          // "spaghetti" tunnels: both noises near zero
          const r = 0.0042 + (y < 24 ? 0.002 : 0);
          let carve = a * a + b * b < r;
          // big caverns deep down
          if (!carve && y < 40) carve = sampleGrid(gridC, lx, y, lz) < -0.74;
          if (carve) blocks[i] = B.AIR;
        }
      }
    }

    // -------- decorations (trees overlap chunk borders => margin scan) --------
    const set = (wx, wy, wz, id, replaceLeavesToo = false) => {
      const lx = wx - x0, lz = wz - z0;
      if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK || wy < 1 || wy >= WORLD_H) return;
      const i = idx(lx, wy, lz);
      const cur = blocks[i];
      if (cur === B.AIR || (replaceLeavesToo && (cur === B.LEAVES || cur === B.SPRUCE_LEAVES))) {
        blocks[i] = id;
      }
    };
    const getLocal = (wx, wy, wz) => {
      const lx = wx - x0, lz = wz - z0;
      if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK || wy < 0 || wy >= WORLD_H) return -1;
      return blocks[idx(lx, wy, lz)];
    };

    const M = 3; // margin for structures leaking across borders
    for (let wz = z0 - M; wz < z0 + CHUNK + M; wz++) {
      for (let wx = x0 - M; wx < x0 + CHUNK + M; wx++) {
        const info = col(wx, wz);
        const { h, biome } = info;
        if (h <= SEA) continue; // underwater columns: nothing to plant
        if (info.surface === B.SAND && biome !== BIOME.DESERT) continue; // bare beaches
        const rnd = hf(hash2(wx, wz, seed ^ 0x7ee5));

        // ---- trees ----
        const spruce = biome === BIOME.SNOWY || biome === BIOME.MOUNTAINS;
        let treeChance = 0;
        if (biome === BIOME.FOREST) treeChance = 0.042;
        else if (biome === BIOME.PLAINS) treeChance = 0.004;
        else if (biome === BIOME.SNOWY) treeChance = 0.018;
        else if (biome === BIOME.MOUNTAINS && info.surface === B.GRASS) treeChance = 0.01;
        if (treeChance > 0 && rnd < treeChance && (info.surface === B.GRASS || info.surface === B.SNOW_GRASS)) {
          const hb = hash2(wx, wz, seed ^ 0x73ee);
          if (spruce) {
            const th = 6 + (hb % 3);
            for (let k = 1; k <= th; k++) set(wx, h + k, wz, B.SPRUCE_LOG);
            for (let ly = 2; ly <= th + 1; ly++) {
              const d = th + 1 - ly;
              const r = d === 0 ? 0 : d === 1 ? 1 : (d % 2 === 0 ? 1 : 2);
              for (let dz = -r; dz <= r; dz++)
                for (let dx = -r; dx <= r; dx++) {
                  if (dx === 0 && dz === 0 && ly <= th) continue;
                  if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
                  set(wx + dx, h + ly, wz + dz, B.SPRUCE_LEAVES);
                }
            }
            set(wx, h + th + 1, wz, B.SPRUCE_LEAVES);
          } else {
            const th = 4 + (hb % 3);
            for (let k = 1; k <= th; k++) set(wx, h + k, wz, B.LOG);
            for (let ly = th - 2; ly <= th + 1; ly++) {
              const r = ly <= th - 1 ? 2 : 1;
              for (let dz = -r; dz <= r; dz++)
                for (let dx = -r; dx <= r; dx++) {
                  if (dx === 0 && dz === 0 && ly <= th) continue;
                  const corner = Math.abs(dx) === r && Math.abs(dz) === r;
                  if (corner && (r === 2 || ly === th + 1) && hash3(wx + dx, h + ly, wz + dz, seed) % 5 < 3) continue;
                  set(wx + dx, h + ly, wz + dz, B.LEAVES);
                }
            }
          }
          // dirt under the trunk
          const lxT = wx - x0, lzT = wz - z0;
          if (lxT >= 0 && lxT < CHUNK && lzT >= 0 && lzT < CHUNK) {
            blocks[idx(lxT, h, lzT)] = B.DIRT;
          }
          continue;
        }

        // ---- desert: cactus / dead bush ----
        if (biome === BIOME.DESERT) {
          if (rnd < 0.0045 && getLocal(wx, h, wz) === B.SAND) {
            const ch = 1 + (hash2(wx, wz, seed ^ 0xcac) % 3);
            for (let k = 1; k <= ch; k++) set(wx, h + k, wz, B.CACTUS);
          } else if (rnd > 0.994) {
            set(wx, h + 1, wz, B.DEADBUSH);
          }
          continue;
        }

        // ---- grass / flowers / pumpkins ----
        if (info.surface === B.GRASS) {
          if (rnd < (biome === BIOME.FOREST ? 0.06 : 0.045)) set(wx, h + 1, wz, B.TALLGRASS);
          else if (rnd < (biome === BIOME.FOREST ? 0.072 : 0.055)) {
            set(wx, h + 1, wz, hash2(wx, wz, seed ^ 0xf10) % 2 ? B.FLOWER_RED : B.FLOWER_YELLOW);
          } else if (biome === BIOME.PLAINS && rnd > 0.9991) {
            set(wx, h + 1, wz, B.PUMPKIN);
          }
        }
      }
    }

    // -------- skylight heightmap (terrain that casts darkness) --------
    this.computeHeights(chunk);
  }

  computeHeights(chunk) {
    const { blocks, heights } = chunk;
    for (let lz = 0; lz < CHUNK; lz++)
      for (let lx = 0; lx < CHUNK; lx++) {
        let y = WORLD_H - 1;
        for (; y > 0; y--) {
          if (COUNTS_HEIGHT[blocks[idx(lx, y, lz)]]) break;
        }
        heights[lx + lz * CHUNK] = y;
      }
  }
}

export { COUNTS_HEIGHT };
