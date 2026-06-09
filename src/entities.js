// ============================================================
// Entities — falling sand/gravel and primed TNT (with chained
// explosions, knockback, crater carving and debris particles).
// ============================================================

import * as THREE from 'three';
import { B, BLOCKS } from './blocks.js';
import { buildBlockGeometry } from './mesher.js';
import { hash3, hf } from './noise.js';
import { WORLD_H } from './worldgen.js';

const GRAVITY = 30;

export class Entities {
  constructor({ scene, world, particles, audio, material }) {
    this.scene = scene;
    this.world = world;
    this.particles = particles;
    this.audio = audio;
    this.material = material;
    this.list = [];
    this.geoCache = new Map();
    this.onExplosion = null; // set by main (camera shake)
    this.getPlayer = null;   // set by main (knockback)

    this.flashMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false,
    });
  }

  setWorld(world) { this.world = world; this.clear(); }

  geometryFor(id) {
    let g = this.geoCache.get(id);
    if (!g) { g = buildBlockGeometry(id); this.geoCache.set(id, g); }
    return g;
  }

  makeMesh(id) {
    const mesh = new THREE.Mesh(this.geometryFor(id), this.material);
    this.scene.add(mesh);
    return mesh;
  }

  // ----------------------------------------------------------
  // Falling blocks (sand / gravel)
  // ----------------------------------------------------------

  spawnFallingBlock(x, y, z, id) {
    if (this.list.length > 80) return; // sanity cap
    this.world.setBlock(x, y, z, B.AIR, { silent: false });
    const mesh = this.makeMesh(id);
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.list.push({ type: 'falling', id, mesh, vy: 0 });
  }

  // ----------------------------------------------------------
  // TNT
  // ----------------------------------------------------------

  igniteTNT(x, y, z, fuse = 1.5) {
    this.world.setBlock(x, y, z, B.AIR, { silent: true });
    const mesh = this.makeMesh(B.TNT);
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    const flash = new THREE.Mesh(this.geometryFor(B.TNT), this.flashMat);
    flash.scale.setScalar(1.02);
    flash.visible = false;
    mesh.add(flash);
    this.list.push({ type: 'tnt', mesh, flash, fuse, age: 0 });
    if (this.audio) this.audio.fuse();
  }

  explode(cx, cy, cz, radius = 4.4) {
    const removedIds = [];
    const seed = (cx * 341 + cy * 173 + cz * 51) | 0;
    for (let dy = -radius - 1; dy <= radius + 1; dy++) {
      for (let dz = -radius - 1; dz <= radius + 1; dz++) {
        for (let dx = -radius - 1; dx <= radius + 1; dx++) {
          const x = Math.round(cx + dx), y = Math.round(cy + dy), z = Math.round(cz + dz);
          if (y < 1 || y >= WORLD_H) continue;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          // jagged crater edge
          const edge = radius * (0.82 + hf(hash3(x, y, z, seed)) * 0.35);
          if (d > edge) continue;
          const id = this.world.getBlock(x, y, z);
          if (id === B.AIR || id === B.WATER) continue;
          const def = BLOCKS[id];
          if (!def || def.hardness === Infinity || id === B.OBSIDIAN) continue;
          if (id === B.TNT) {
            this.igniteTNT(x, y, z, 0.25 + Math.random() * 0.65);
            continue;
          }
          this.world.setBlock(x, y, z, B.AIR);
          if (removedIds.length < 24) removedIds.push(id);
        }
      }
    }

    if (this.particles && removedIds.length) {
      this.particles.spawnExplosion(cx, cy, cz, removedIds);
    }
    if (this.audio) this.audio.explosion();

    // knockback
    const player = this.getPlayer ? this.getPlayer() : null;
    if (player) {
      const px = player.pos.x - cx, py = player.pos.y + 0.9 - cy, pz = player.pos.z - cz;
      const d = Math.sqrt(px * px + py * py + pz * pz);
      const range = radius * 2.1;
      if (d < range && d > 0.001) {
        const f = (1 - d / range) * 17;
        player.vel.x += (px / d) * f;
        player.vel.y += (py / d) * f * 0.6 + f * 0.25;
        player.vel.z += (pz / d) * f;
      }
    }
    if (this.onExplosion) this.onExplosion(cx, cy, cz);
  }

  // ----------------------------------------------------------
  // Update
  // ----------------------------------------------------------

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];

      if (e.type === 'falling') {
        e.vy -= GRAVITY * dt;
        e.mesh.position.y += e.vy * dt;
        const bx = Math.floor(e.mesh.position.x);
        const bz = Math.floor(e.mesh.position.z);
        const below = Math.floor(e.mesh.position.y - 0.5);
        const belowId = this.world.getBlock(bx, below, bz);
        if (belowId !== B.AIR && BLOCKS[belowId].solid) {
          // settle on top of the solid block (replaces grass/flowers)
          this.world.setBlock(bx, below + 1, bz, e.id);
          this.despawn(i);
        } else if (e.mesh.position.y < -10) {
          this.despawn(i);
        }
      } else if (e.type === 'tnt') {
        e.fuse -= dt;
        e.age += dt;
        const rate = e.fuse < 0.5 ? 14 : 7;
        e.flash.visible = Math.floor(e.age * rate) % 2 === 0;
        const pulse = 1 + Math.max(0, 0.5 - e.fuse) * 0.5;
        e.mesh.scale.setScalar(Math.min(pulse, 1.25));
        if (e.fuse <= 0) {
          const p = e.mesh.position;
          const px = p.x, py = p.y, pz = p.z;
          this.despawn(i);
          this.explode(px, py, pz);
        }
      }
    }
  }

  despawn(i) {
    const e = this.list[i];
    this.scene.remove(e.mesh);
    this.list.splice(i, 1);
  }

  clear() {
    for (const e of this.list) this.scene.remove(e.mesh);
    this.list = [];
  }
}
