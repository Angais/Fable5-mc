// ============================================================
// World — chunk storage, streaming (generate/mesh/unload with
// a per-frame time budget), block get/set with dirty-area
// remeshing, player edit persistence, torch tracking and
// skylight heightmap maintenance.
// ============================================================

import * as THREE from 'three';
import { CHUNK, WORLD_H, WorldGen, COUNTS_HEIGHT } from './worldgen.js';
import { B, BLOCKS } from './blocks.js';
import { buildChunkGeometries } from './mesher.js';

const ckey = (cx, cz) => ((cx & 0xffff) << 16) | (cz & 0xffff);
const bidx = (lx, y, lz) => lx + (lz << 4) + (y << 8);

class Chunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.blocks = null;     // Uint8Array(16*16*128)
    this.heights = null;    // Uint8Array(256) — skylight heightmap
    this.biomes = null;     // Uint8Array(256)
    this.torches = [];      // [x,y,z] world coords
    this.solidMesh = null;
    this.waterMesh = null;
    this.state = 'pending'; // pending -> generated -> ready
  }
}

export class World {
  /**
   * @param {object} o
   * @param {number} o.seed
   * @param {THREE.Scene|object} o.scene       anything with add/remove
   * @param {object} o.materials               { solid, water }
   * @param {number} o.viewRadius              chunks
   * @param {boolean} o.smoothLighting
   */
  constructor({ seed, scene, materials, viewRadius = 7, smoothLighting = true }) {
    this.seed = seed >>> 0;
    this.gen = new WorldGen(this.seed);
    this.scene = scene;
    this.materials = materials;
    this.viewRadius = viewRadius;
    this.smoothLighting = smoothLighting;

    this.chunks = new Map();           // ckey -> Chunk
    this.editsByChunk = new Map();     // ckey -> Map(blockIdx -> id)
    this.editCount = 0;
    this.dirty = new Set();            // ckeys needing remesh
    this.supportChecks = [];           // cells to re-check after edits (sand, torches…)
    this.stats = { generated: 0, meshed: 0 };
  }

  // ----------------------------------------------------------
  // Access
  // ----------------------------------------------------------

  getChunk(cx, cz) { return this.chunks.get(ckey(cx, cz)); }

  getBlock(x, y, z) {
    if (y < 0 || y >= WORLD_H) return B.AIR;
    const c = this.chunks.get(ckey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
    if (!c || !c.blocks) return B.AIR;
    return c.blocks[bidx(x & 15, y, z & 15)];
  }

  isLoaded(x, z) {
    const c = this.chunks.get(ckey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
    return !!(c && c.blocks);
  }

  /** Highest skylight-blocking block of the column (0 if none). */
  surfaceHeight(x, z) {
    const c = this.chunks.get(ckey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
    if (!c || !c.heights) return 0;
    return c.heights[(x & 15) + ((z & 15) << 4)];
  }

  biomeAt(x, z) {
    const c = this.chunks.get(ckey(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
    if (!c || !c.biomes) return this.gen.biomeAt(x, z);
    return c.biomes[(x & 15) + ((z & 15) << 4)];
  }

  getTorchesNear(cx, cz) {
    const out = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(ckey(cx + dx, cz + dz));
        if (c) for (const t of c.torches) out.push(t);
      }
    return out;
  }

  // ----------------------------------------------------------
  // Editing
  // ----------------------------------------------------------

  /**
   * Set a block. Records the edit (for persistence), maintains the
   * skylight heightmap + torch lists, marks affected chunks dirty and
   * queues gravity/support checks for the game loop.
   */
  setBlock(x, y, z, id, { record = true, silent = false } = {}) {
    if (y < 1 || y >= WORLD_H) return null;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.chunks.get(ckey(cx, cz));
    if (!c || !c.blocks) return null;

    const lx = x & 15, lz = z & 15;
    const i = bidx(lx, y, lz);
    const old = c.blocks[i];
    if (old === id) return null;
    c.blocks[i] = id;

    // --- torch list ---
    if (old === B.TORCH) {
      c.torches = c.torches.filter((t) => t[0] !== x || t[1] !== y || t[2] !== z);
    }
    if (id === B.TORCH) c.torches.push([x, y, z]);

    // --- skylight heightmap ---
    const hi = lx + (lz << 4);
    const hCur = c.heights[hi];
    if (COUNTS_HEIGHT[id]) {
      if (y > hCur) c.heights[hi] = y;
    } else if (y === hCur) {
      let yy = y - 1;
      while (yy > 0 && !COUNTS_HEIGHT[c.blocks[bidx(lx, yy, lz)]]) yy--;
      c.heights[hi] = yy;
    }

    // --- record edit for persistence ---
    if (record) {
      let m = this.editsByChunk.get(ckey(cx, cz));
      if (!m) { m = new Map(); this.editsByChunk.set(ckey(cx, cz), m); }
      if (!m.has(i)) this.editCount++;
      m.set(i, id);
    }

    // --- remesh area (torch placement/removal lights a big radius) ---
    const lightRadius = (old === B.TORCH || id === B.TORCH) ? 10 : 1;
    this.markDirtyArea(x, y, z, lightRadius);

    // --- queue support / gravity checks ---
    if (!silent) {
      this.supportChecks.push([x, y + 1, z]);
      if (id !== B.AIR) this.supportChecks.push([x, y, z]); // placed block may need support itself
    }

    return old;
  }

  markDirtyArea(x, y, z, r) {
    const cx0 = Math.floor((x - r) / CHUNK), cx1 = Math.floor((x + r) / CHUNK);
    const cz0 = Math.floor((z - r) / CHUNK), cz1 = Math.floor((z + r) / CHUNK);
    for (let cz = cz0; cz <= cz1; cz++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.chunks.get(ckey(cx, cz));
        if (c && c.state === 'ready') this.dirty.add(ckey(cx, cz));
      }
  }

  // ----------------------------------------------------------
  // Persistence
  // ----------------------------------------------------------

  serializeEdits() {
    const out = [];
    for (const [key, m] of this.editsByChunk) {
      const cx = key >> 16;                 // sign-extends
      const cz = (key << 16) >> 16;
      for (const [i, id] of m) out.push([cx, cz, i, id]);
    }
    return out;
  }

  loadEdits(list) {
    if (!Array.isArray(list)) return;
    for (const [cx, cz, i, id] of list) {
      const key = ckey(cx, cz);
      let m = this.editsByChunk.get(key);
      if (!m) { m = new Map(); this.editsByChunk.set(key, m); }
      m.set(i, id);
      this.editCount++;
    }
  }

  applyEditsToChunk(c) {
    const m = this.editsByChunk.get(ckey(c.cx, c.cz));
    if (!m) return;
    for (const [i, id] of m) {
      c.blocks[i] = id;
      if (id === B.TORCH) {
        const lx = i & 15, lz = (i >> 4) & 15, y = i >> 8;
        c.torches.push([c.cx * CHUNK + lx, y, c.cz * CHUNK + lz]);
      }
    }
  }

  // ----------------------------------------------------------
  // Streaming
  // ----------------------------------------------------------

  /**
   * Stream chunks around (px, pz). Generates within viewRadius+1,
   * meshes within viewRadius, unloads beyond viewRadius+2.
   * Spends at most budgetMs per call.
   */
  update(px, pz, budgetMs = 5) {
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    const R = this.viewRadius, GR = R + 1;
    const t0 = performance.now();

    // ---- ensure chunk records exist / unload far chunks ----
    for (let dz = -GR; dz <= GR; dz++)
      for (let dx = -GR; dx <= GR; dx++) {
        if (dx * dx + dz * dz > (GR + 0.5) * (GR + 0.5)) continue;
        const cx = pcx + dx, cz = pcz + dz;
        const key = ckey(cx, cz);
        if (!this.chunks.has(key)) this.chunks.set(key, new Chunk(cx, cz));
      }
    for (const [key, c] of this.chunks) {
      const dx = c.cx - pcx, dz = c.cz - pcz;
      if (dx * dx + dz * dz > (GR + 2) * (GR + 2)) {
        this.disposeChunk(c);
        this.chunks.delete(key);
        this.dirty.delete(key);
      }
    }

    // ---- work queues, nearest first ----
    const genList = [];
    const meshList = [];
    for (const c of this.chunks.values()) {
      const dx = c.cx - pcx, dz = c.cz - pcz;
      const d2 = dx * dx + dz * dz;
      if (c.state === 'pending') genList.push([d2, c]);
      else if (c.state === 'generated' && d2 <= R * R + 1 && this.neighborsGenerated(c)) {
        meshList.push([d2, c]);
      }
    }
    genList.sort((a, b) => a[0] - b[0]);
    meshList.sort((a, b) => a[0] - b[0]);

    // dirty chunks first (player edits feel instant), then mesh, then gen
    let worked = true;
    while (worked && performance.now() - t0 < budgetMs) {
      worked = false;
      if (this.dirty.size) {
        let best = null, bestD = Infinity;
        for (const key of this.dirty) {
          const c = this.chunks.get(key);
          if (!c) { this.dirty.delete(key); continue; }
          const dx = c.cx - pcx, dz = c.cz - pcz;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD) { bestD = d2; best = c; }
        }
        if (best && this.neighborsGenerated(best)) {
          this.dirty.delete(ckey(best.cx, best.cz));
          this.meshChunk(best);
          worked = true;
          continue;
        } else if (best) {
          // can't mesh yet — wait until neighbors generate
          this.dirty.delete(ckey(best.cx, best.cz));
          this.dirty.add(ckey(best.cx, best.cz));
        }
      }
      if (meshList.length) {
        const [, c] = meshList.shift();
        if (c.state === 'generated') { this.meshChunk(c); worked = true; continue; }
      }
      if (genList.length) {
        const [, c] = genList.shift();
        if (c.state === 'pending') { this.generateChunk(c); worked = true; }
      }
    }
  }

  neighborsGenerated(c) {
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const n = this.chunks.get(ckey(c.cx + dx, c.cz + dz));
        if (!n || !n.blocks) return false;
      }
    return true;
  }

  generateChunk(c) {
    c.blocks = new Uint8Array(CHUNK * CHUNK * WORLD_H);
    c.heights = new Uint8Array(CHUNK * CHUNK);
    c.biomes = new Uint8Array(CHUNK * CHUNK);
    this.gen.generate(c);
    this.applyEditsToChunk(c);
    this.gen.computeHeights(c); // edits may change the heightmap
    c.state = 'generated';
    this.stats.generated++;
  }

  meshChunk(c) {
    const { solid, water } = buildChunkGeometries(this, c, { smoothLighting: this.smoothLighting });
    this.removeMeshes(c);
    if (solid) {
      c.solidMesh = new THREE.Mesh(solid, this.materials.solid);
      this.placeMesh(c, c.solidMesh);
    }
    if (water) {
      c.waterMesh = new THREE.Mesh(water, this.materials.water);
      c.waterMesh.renderOrder = 2;
      this.placeMesh(c, c.waterMesh);
    }
    c.state = 'ready';
    this.stats.meshed++;
  }

  placeMesh(c, mesh) {
    mesh.position.set(c.cx * CHUNK, 0, c.cz * CHUNK);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
  }

  removeMeshes(c) {
    for (const k of ['solidMesh', 'waterMesh']) {
      const m = c[k];
      if (m) {
        this.scene.remove(m);
        m.geometry.dispose();
        c[k] = null;
      }
    }
  }

  disposeChunk(c) {
    this.removeMeshes(c);
    c.blocks = null;
    c.heights = null;
    c.biomes = null;
    c.state = 'pending';
  }

  /** Remesh every ready chunk (used when toggling smooth lighting). */
  remeshAll() {
    for (const c of this.chunks.values()) {
      if (c.state === 'ready') this.dirty.add(ckey(c.cx, c.cz));
    }
  }

  /** Loading progress around a position (for the loading screen). */
  readiness(px, pz, radius) {
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    let ready = 0, total = 0;
    for (let dz = -radius; dz <= radius; dz++)
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > radius * radius + 1) continue;
        total++;
        const c = this.chunks.get(ckey(pcx + dx, pcz + dz));
        if (c && c.state === 'ready') ready++;
      }
    return { ready, total };
  }

  countLoaded() {
    let n = 0;
    for (const c of this.chunks.values()) if (c.state === 'ready') n++;
    return n;
  }

  dispose() {
    for (const c of this.chunks.values()) this.disposeChunk(c);
    this.chunks.clear();
    this.dirty.clear();
  }
}
