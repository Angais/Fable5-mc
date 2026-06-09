// ============================================================
// Chunk mesher.
// Converts a 16x128x16 voxel chunk into BufferGeometry with:
//   - hidden face culling (incl. same-type culling for water,
//     glass and leaves)
//   - per-vertex ambient occlusion (0fps algorithm) + quad
//     flipping to avoid the classic AO diagonal artifact
//   - Minecraft-style directional face shading
//   - smooth "skylight" (depth-below-terrain darkness, so caves
//     are dark) and torch light, baked into vertex colors:
//       color.r = skylight  (scaled by day/night uniform)
//       color.g = torchlight (warm, constant)
//   - liquids with lowered surface, cross-shaped plants, torches
// ============================================================

import * as THREE from 'three';
import { B, BLOCKS } from './blocks.js';
import { atlasUV } from './textures.js';
import { CHUNK, WORLD_H, SEA, BIOME } from './worldgen.js';

const AO_CURVE = [0.45, 0.64, 0.82, 1.0];
const FACE_SHADE = { px: 0.6, nx: 0.6, py: 1.0, ny: 0.5, pz: 0.8, nz: 0.8 };

// ------------------------------------------------------------
// Face table (generated programmatically, winding self-checked)
// ------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function makeFace(normal, t1, t2, key) {
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s1, s2]) => {
    const pos = [
      0.5 + 0.5 * (normal[0] + s1 * t1[0] + s2 * t2[0]),
      0.5 + 0.5 * (normal[1] + s1 * t1[1] + s2 * t2[1]),
      0.5 + 0.5 * (normal[2] + s1 * t1[2] + s2 * t2[2]),
    ];
    let u, v;
    if (normal[1] !== 0) { u = pos[0]; v = pos[2]; }       // top/bottom: u=x, v=z
    else { v = pos[1]; u = normal[0] !== 0 ? pos[2] : pos[0]; } // sides: v follows world Y
    return { s1, s2, pos, u, v };
  });
  // enforce CCW winding viewed from outside
  const cr = cross(sub(corners[1].pos, corners[0].pos), sub(corners[3].pos, corners[0].pos));
  if (dot(cr, normal) < 0) corners.reverse();
  return { n: normal, t1, t2, key, corners };
}

const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
export const FACES = [
  makeFace([1, 0, 0], Y, Z, 'px'),
  makeFace([-1, 0, 0], Z, Y, 'nx'),
  makeFace([0, 1, 0], Z, X, 'py'),
  makeFace([0, -1, 0], X, Z, 'ny'),
  makeFace([0, 0, 1], X, Y, 'pz'),
  makeFace([0, 0, -1], Y, X, 'nz'),
];

// cached uv rects
const UV_CACHE = new Map();
function uvRect(name) {
  let r = UV_CACHE.get(name);
  if (!r) { r = atlasUV(name); UV_CACHE.set(name, r); }
  return r;
}

const OCCLUDES = new Uint8Array(256);
const OPAQUE = new Uint8Array(256);
const CULL_SAME = new Uint8Array(256);
for (const d of BLOCKS) {
  if (!d) continue;
  OCCLUDES[d.id] = d.aoCast ? 1 : 0;
  OPAQUE[d.id] = d.opaque ? 1 : 0;
  CULL_SAME[d.id] = d.cullSame ? 1 : 0;
}

// ------------------------------------------------------------
// 3x3-chunk sampler (fast cross-border lookups during meshing)
// ------------------------------------------------------------

function makeSampler(world, cx, cz) {
  const blocksArr = [], heightsArr = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const ch = world.getChunk(cx + dx, cz + dz);
      blocksArr.push(ch && ch.blocks ? ch.blocks : null);
      heightsArr.push(ch && ch.heights ? ch.heights : null);
    }
  return {
    block(lx, y, lz) {
      if (y < 0 || y >= WORLD_H) return B.AIR;
      const ax = lx + 16, az = lz + 16;
      const arr = blocksArr[(az >> 4) * 3 + (ax >> 4)];
      return arr ? arr[(ax & 15) + ((az & 15) << 4) + (y << 8)] : B.AIR;
    },
    height(lx, lz) {
      const ax = lx + 16, az = lz + 16;
      const arr = heightsArr[(az >> 4) * 3 + (ax >> 4)];
      return arr ? arr[(ax & 15) + ((az & 15) << 4)] : 0;
    },
  };
}

// ------------------------------------------------------------
// Geometry builder helper
// ------------------------------------------------------------

class GeoBuf {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.col = [];
    this.index = [];
  }
  /** verts: 4 x {x,y,z,u,v,r,g}; flip: alternate quad diagonal */
  quad(verts, flip = false) {
    const base = this.pos.length / 3;
    for (const v of verts) {
      this.pos.push(v.x, v.y, v.z);
      this.uv.push(v.u, v.v);
      this.col.push(v.r, v.g, 0);
    }
    if (flip) this.index.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
    else this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  build() {
    if (this.index.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setIndex(this.index); // three picks Uint16/Uint32 automatically
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(CHUNK / 2, WORLD_H / 2, CHUNK / 2),
      Math.sqrt(CHUNK * CHUNK / 2 + WORLD_H * WORLD_H / 4) + 2,
    );
    return g;
  }
}

// ------------------------------------------------------------
// Lighting helpers
// ------------------------------------------------------------

function skyLightAt(s, lx, y, lz, id) {
  const h = s.height(lx, lz);
  let v = y >= h ? 1 : Math.max(0.12, 1 - (h - y) * 0.1);
  if (id === B.WATER && y < SEA) {
    v *= Math.max(0.3, 1 - (SEA - y) * 0.07); // dimmer with water depth
  }
  return v;
}

function torchLightAt(torches, wx, wy, wz) {
  let v = 0;
  for (let i = 0; i < torches.length; i++) {
    const t = torches[i];
    const dx = wx - t[0], dy = wy - t[1], dz = wz - t[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const l = 1 - d / 9;
    if (l > v) v = l;
  }
  return v;
}

// ------------------------------------------------------------
// Main entry
// ------------------------------------------------------------

/**
 * Build solid + water geometries for a chunk. All 8 neighbor chunks
 * must already be generated (the world guarantees this).
 * Returns { solid: BufferGeometry|null, water: BufferGeometry|null }
 */
export function buildChunkGeometries(world, chunk, { smoothLighting = true } = {}) {
  const s = makeSampler(world, chunk.cx, chunk.cz);
  const torches = world.getTorchesNear(chunk.cx, chunk.cz);
  const hasTorches = torches.length > 0;
  const ox = chunk.cx * CHUNK, oz = chunk.cz * CHUNK;
  const solid = new GeoBuf();
  const water = new GeoBuf();
  const blocks = chunk.blocks;
  const biomes = chunk.biomes;

  const verts = [{}, {}, {}, {}].map(() => ({ x: 0, y: 0, z: 0, u: 0, v: 0, r: 0, g: 0 }));

  for (let y = 0; y < WORLD_H; y++) {
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const id = blocks[lx + (lz << 4) + (y << 8)];
        if (id === B.AIR) continue;
        const def = BLOCKS[id];
        const biome = biomes[lx + (lz << 4)];

        if (def.shape === 'cross') {
          emitCross(solid, s, torches, hasTorches, def, lx, y, lz, ox, oz);
          continue;
        }
        if (def.shape === 'torch') {
          emitTorch(solid, def, lx, y, lz);
          continue;
        }

        const isLiquid = def.shape === 'liquid';
        const buf = isLiquid ? water : solid;
        const aboveSame = isLiquid && s.block(lx, y + 1, lz) === id;

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const nIdx = s.block(lx + face.n[0], y + face.n[1], lz + face.n[2]);
          // visibility
          if (nIdx === id && CULL_SAME[id]) continue;
          if (nIdx !== B.AIR && OPAQUE[nIdx]) continue;
          if (isLiquid && nIdx === B.WATER) continue;

          // tile selection (biome-tinted grass tops in forests)
          let tile = def.tex[face.key];
          if (id === B.GRASS && face.key === 'py' && biome === BIOME.FOREST) tile = 'grass_top_forest';
          const rect = isLiquid ? null : uvRect(tile);

          const shade = FACE_SHADE[face.key];
          const cellX = lx + face.n[0], cellY = y + face.n[1], cellZ = lz + face.n[2];
          const aos = [3, 3, 3, 3];

          for (let ci = 0; ci < 4; ci++) {
            const c = face.corners[ci];
            const v = verts[ci];

            // ---- vertex position (liquid tops are lowered) ----
            let py = c.pos[1];
            if (isLiquid && !aboveSame && py === 1) py = 0.875;
            v.x = lx + c.pos[0];
            v.y = y + py;
            v.z = lz + c.pos[2];

            // ---- ambient occlusion + smooth sky light ----
            let ao = 3, sky;
            if (!isLiquid && smoothLighting) {
              const s1x = cellX + c.s1 * face.t1[0], s1y = cellY + c.s1 * face.t1[1], s1z = cellZ + c.s1 * face.t1[2];
              const s2x = cellX + c.s2 * face.t2[0], s2y = cellY + c.s2 * face.t2[1], s2z = cellZ + c.s2 * face.t2[2];
              const ccx = cellX + c.s1 * face.t1[0] + c.s2 * face.t2[0];
              const ccy = cellY + c.s1 * face.t1[1] + c.s2 * face.t2[1];
              const ccz = cellZ + c.s1 * face.t1[2] + c.s2 * face.t2[2];
              const id1 = s.block(s1x, s1y, s1z), id2 = s.block(s2x, s2y, s2z), idc = s.block(ccx, ccy, ccz);
              const o1 = OCCLUDES[id1], o2 = OCCLUDES[id2], oc = OCCLUDES[idc];
              ao = (o1 && o2) ? 0 : 3 - (o1 + o2 + oc);
              const cellId = s.block(cellX, cellY, cellZ);
              sky = skyLightAt(s, cellX, cellY, cellZ, cellId);
              let cnt = 1;
              if (!o1) { sky += skyLightAt(s, s1x, s1y, s1z, id1); cnt++; }
              if (!o2) { sky += skyLightAt(s, s2x, s2y, s2z, id2); cnt++; }
              if (!oc && !(o1 && o2)) { sky += skyLightAt(s, ccx, ccy, ccz, idc); cnt++; }
              sky /= cnt;
            } else {
              const cellId = s.block(cellX, cellY, cellZ);
              sky = skyLightAt(s, cellX, cellY, cellZ, cellId);
            }
            aos[ci] = ao;
            const aoB = AO_CURVE[ao];

            // ---- torch light ----
            let torch = 0;
            if (hasTorches) torch = torchLightAt(torches, ox + v.x, v.y, oz + v.z);

            v.r = sky * aoB * shade;
            v.g = torch * aoB * shade;

            // ---- uv ----
            if (isLiquid) {
              // world-tiled animated water texture (repeat-wrapped)
              if (face.key === 'py' || face.key === 'ny') {
                v.u = (ox + v.x) / 4; v.v = (oz + v.z) / 4;
              } else {
                v.u = (face.n[0] !== 0 ? oz + v.z : ox + v.x) / 4;
                v.v = v.y / 4;
              }
            } else {
              v.u = rect.u0 + (rect.u1 - rect.u0) * c.u;
              v.v = rect.v0 + (rect.v1 - rect.v0) * c.v;
            }
          }

          // flip quad diagonal when AO is asymmetric (kills seam artifacts)
          buf.quad(verts, aos[0] + aos[2] > aos[1] + aos[3]);
        }
      }
    }
  }

  return { solid: solid.build(), water: water.build() };
}

// ------------------------------------------------------------
// Cross-shaped blocks (flowers, tall grass, dead bushes)
// ------------------------------------------------------------

function emitCross(buf, s, torches, hasTorches, def, lx, y, lz, ox, oz) {
  const rect = uvRect(def.tex.py);
  const cellId = s.block(lx, y, lz);
  const sky = skyLightAt(s, lx, y, lz, cellId);
  const torch = hasTorches ? torchLightAt(torches, ox + lx + 0.5, y + 0.5, oz + lz + 0.5) : 0;

  // deterministic little offset, like Minecraft's plant jitter
  const hsh = ((lx * 73856093) ^ (lz * 19349663) ^ (y * 83492791)) >>> 0;
  const offX = ((hsh & 15) / 15 - 0.5) * 0.3;
  const offZ = (((hsh >> 4) & 15) / 15 - 0.5) * 0.3;

  const a = 0.15, b = 0.85;
  const planes = [
    [[a, a], [b, b]],
    [[a, b], [b, a]],
  ];
  for (const [[x0, z0], [x1, z1]] of planes) {
    for (const flip of [false, true]) {
      const corners = [
        { x: x0, z: z0, u: 0, vy: 0 },
        { x: x1, z: z1, u: 1, vy: 0 },
        { x: x1, z: z1, u: 1, vy: 1 },
        { x: x0, z: z0, u: 0, vy: 1 },
      ];
      const list = flip ? [...corners].reverse() : corners;
      buf.quad(list.map((c) => ({
        x: lx + c.x + offX,
        y: y + c.vy,
        z: lz + c.z + offZ,
        u: rect.u0 + (rect.u1 - rect.u0) * c.u,
        v: rect.v0 + (rect.v1 - rect.v0) * c.vy,
        r: sky,
        g: torch,
      })));
    }
  }
}

// ------------------------------------------------------------
// Torches (tiny 2px-wide post, always fullbright)
// ------------------------------------------------------------

function emitTorch(buf, def, lx, y, lz) {
  const rect = uvRect(def.tex.py);
  const uw = rect.u1 - rect.u0, vw = rect.v1 - rect.v0;
  const a = 7 / 16, b = 9 / 16, h = 10 / 16;
  const mapU = (t) => rect.u0 + uw * t;
  const mapV = (t) => rect.v0 + vw * t;
  const u0 = mapU(7 / 16), u1 = mapU(9 / 16), v0 = mapV(0), v1 = mapV(10 / 16);

  // each side: two bottom verts then two top verts, wound CCW from outside
  const sideQuad = (p0, p1) => {
    buf.quad([
      { x: lx + p0[0], y: y, z: lz + p0[1], u: u0, v: v0, r: 1, g: 1 },
      { x: lx + p1[0], y: y, z: lz + p1[1], u: u1, v: v0, r: 1, g: 1 },
      { x: lx + p1[0], y: y + h, z: lz + p1[1], u: u1, v: v1, r: 1, g: 1 },
      { x: lx + p0[0], y: y + h, z: lz + p0[1], u: u0, v: v1, r: 1, g: 1 },
    ]);
  };
  sideQuad([b, a], [a, a]); // faces -z
  sideQuad([a, b], [b, b]); // faces +z
  sideQuad([a, a], [a, b]); // faces -x
  sideQuad([b, b], [b, a]); // faces +x

  // top cap (samples the flame pixels), faces +y
  const cu0 = mapU(7 / 16), cu1 = mapU(9 / 16), cv0 = mapV(9 / 16), cv1 = mapV(11 / 16);
  buf.quad([
    { x: lx + a, y: y + h, z: lz + a, u: cu0, v: cv0, r: 1, g: 1 },
    { x: lx + a, y: y + h, z: lz + b, u: cu0, v: cv1, r: 1, g: 1 },
    { x: lx + b, y: y + h, z: lz + b, u: cu1, v: cv1, r: 1, g: 1 },
    { x: lx + b, y: y + h, z: lz + a, u: cu1, v: cv0, r: 1, g: 1 },
  ]);
}

// ------------------------------------------------------------
// Standalone block geometry (held item, falling blocks, icons)
// ------------------------------------------------------------

/** Unit cube (or cross) centered at origin with baked face shading. */
export function buildBlockGeometry(id) {
  const def = BLOCKS[id];
  const buf = new GeoBuf();
  if (def.shape === 'cross') {
    const rect = uvRect(def.tex.py);
    const a = -0.35, b = 0.35;
    for (const [[x0, z0], [x1, z1]] of [[[a, a], [b, b]], [[a, b], [b, a]]]) {
      for (const flip of [false, true]) {
        const corners = [
          { x: x0, z: z0, u: 0, vy: 0 },
          { x: x1, z: z1, u: 1, vy: 0 },
          { x: x1, z: z1, u: 1, vy: 1 },
          { x: x0, z: z0, u: 0, vy: 1 },
        ];
        const list = flip ? [...corners].reverse() : corners;
        buf.quad(list.map((c) => ({
          x: c.x, y: c.vy - 0.5, z: c.z,
          u: rect.u0 + (rect.u1 - rect.u0) * c.u,
          v: rect.v0 + (rect.v1 - rect.v0) * c.vy,
          r: 1, g: 0,
        })));
      }
    }
  } else {
    for (const face of FACES) {
      const tile = def.tex[face.key];
      const rect = uvRect(tile === 'water_still' ? 'water_still' : tile);
      const shade = FACE_SHADE[face.key];
      buf.quad(face.corners.map((c) => ({
        x: c.pos[0] - 0.5, y: c.pos[1] - 0.5, z: c.pos[2] - 0.5,
        u: rect.u0 + (rect.u1 - rect.u0) * c.u,
        v: rect.v0 + (rect.v1 - rect.v0) * c.v,
        r: shade, g: 0,
      })));
    }
  }
  const g = buf.build();
  g.computeBoundingSphere();
  return g;
}
