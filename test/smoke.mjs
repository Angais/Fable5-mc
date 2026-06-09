// ============================================================
// Headless smoke tests (node): worldgen determinism, chunk
// streaming + meshing integrity, block editing, raycasting,
// player physics landing. Run: npm install && npm test
// ============================================================

import assert from 'node:assert';
import * as THREE from 'three';
import { SimplexNoise, hashString } from '../src/noise.js';
import { B, BLOCKS, PALETTE } from '../src/blocks.js';
import { WorldGen, CHUNK, WORLD_H, SEA, BIOME_NAMES } from '../src/worldgen.js';
import { World } from '../src/world.js';
import { buildBlockGeometry } from '../src/mesher.js';
import { Player, raycastVoxel } from '../src/player.js';

const fakeScene = { add() {}, remove() {} };
const fakeMaterials = { solid: {}, water: {} };

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('— noise —');
ok('simplex deterministic + bounded', () => {
  const a = new SimplexNoise(123), b = new SimplexNoise(123), c = new SimplexNoise(124);
  let differs = false;
  for (let i = 0; i < 500; i++) {
    const x = i * 0.13, y = i * 0.07;
    assert.strictEqual(a.noise2(x, y), b.noise2(x, y));
    if (a.noise2(x, y) !== c.noise2(x, y)) differs = true;
    assert.ok(Math.abs(a.noise2(x, y)) <= 1.01);
    assert.ok(Math.abs(a.noise3(x, y, x + y)) <= 1.01);
  }
  assert.ok(differs, 'different seeds must differ');
});

console.log('— worldgen —');
const gen = new WorldGen(hashString('test-seed'));
ok('column heights within world bounds', () => {
  for (let x = -200; x <= 200; x += 7) {
    for (let z = -200; z <= 200; z += 11) {
      const c = gen.columnInfo(x, z);
      assert.ok(c.h >= 8 && c.h < WORLD_H, `h=${c.h}`);
      assert.ok(c.biome >= 0 && c.biome < BIOME_NAMES.length);
    }
  }
});
ok('spawn is on dry land', () => {
  const s = gen.findSpawn();
  const c = gen.columnInfo(Math.floor(s.x), Math.floor(s.z));
  assert.ok(c.h >= SEA + 1);
});

console.log('— world streaming & meshing —');
const world = new World({ seed: 42, scene: fakeScene, materials: fakeMaterials, viewRadius: 2 });
// operate around the (dry land) spawn column
const spawn = new WorldGen(42).findSpawn();
const SX = Math.floor(spawn.x), SZ = Math.floor(spawn.z);
const SCX = Math.floor(SX / CHUNK), SCZ = Math.floor(SZ / CHUNK);

ok('chunks generate and mesh', () => {
  for (let i = 0; i < 300; i++) world.update(spawn.x, spawn.z, 50);
  const c = world.getChunk(SCX, SCZ);
  assert.ok(c, 'chunk exists');
  assert.strictEqual(c.state, 'ready');
  assert.ok(c.solidMesh, 'has solid mesh');
  const pos = c.solidMesh.geometry.getAttribute('position');
  assert.ok(pos.count > 100, 'has vertices');
  for (let i = 0; i < pos.array.length; i++) assert.ok(Number.isFinite(pos.array[i]), 'no NaN positions');
  const col = c.solidMesh.geometry.getAttribute('color');
  for (let i = 0; i < col.array.length; i++) {
    assert.ok(col.array[i] >= 0 && col.array[i] <= 1.001, `color in range, got ${col.array[i]}`);
  }
});
ok('bedrock floor everywhere', () => {
  for (let x = 0; x < 16; x++)
    for (let z = 0; z < 16; z++)
      assert.strictEqual(world.getBlock(SCX * CHUNK + x, 0, SCZ * CHUNK + z), B.BEDROCK);
});
ok('terrain matches heightmap sanity', () => {
  const h = world.surfaceHeight(SX, SZ);
  assert.ok(h > 4 && h < WORLD_H);
  assert.notStrictEqual(world.getBlock(SX, h, SZ), B.AIR);
});

console.log('— editing —');
ok('setBlock + heightmap + dirty marking', () => {
  const h = world.surfaceHeight(SX, SZ);
  const y = h + 3;
  world.setBlock(SX, y, SZ, B.STONE);
  assert.strictEqual(world.getBlock(SX, y, SZ), B.STONE);
  assert.strictEqual(world.surfaceHeight(SX, SZ), y, 'heightmap raised');
  assert.ok(world.dirty.size > 0, 'chunk marked dirty');
  world.setBlock(SX, y, SZ, B.AIR);
  assert.strictEqual(world.surfaceHeight(SX, SZ), h, 'heightmap restored');
});
ok('torch tracking', () => {
  const h = world.surfaceHeight(SX, SZ);
  world.setBlock(SX, h + 1, SZ, B.TORCH);
  assert.strictEqual(world.getTorchesNear(SCX, SCZ).length, 1);
  world.setBlock(SX, h + 1, SZ, B.AIR);
  assert.strictEqual(world.getTorchesNear(SCX, SCZ).length, 0);
});
ok('edit persistence roundtrip', () => {
  const h = world.surfaceHeight(SX + 1, SZ + 1);
  world.setBlock(SX + 1, h + 1, SZ + 1, B.BRICKS);
  const ser = world.serializeEdits();
  assert.ok(ser.length > 0);
  const world2 = new World({ seed: 42, scene: fakeScene, materials: fakeMaterials, viewRadius: 2 });
  world2.loadEdits(ser);
  for (let i = 0; i < 300; i++) world2.update(spawn.x, spawn.z, 50);
  assert.strictEqual(world2.getBlock(SX + 1, h + 1, SZ + 1), B.BRICKS, 'edit survives regen');
});

console.log('— raycast —');
ok('downward ray hits terrain', () => {
  const hit = raycastVoxel(world, new THREE.Vector3(SX + 0.5, 120, SZ + 0.5), new THREE.Vector3(0, -1, 0), 140);
  assert.ok(hit, 'hit something');
  assert.strictEqual(hit.ny, 1, 'entered from the top face');
  assert.notStrictEqual(hit.id, B.AIR);
});
ok('sideways ray reports the entry face', () => {
  const y = 110; // well above any terrain
  for (let x = SX - 4; x < SX; x++) world.setBlock(x, y, SZ, B.AIR); // ensure clear path
  world.setBlock(SX, y, SZ, B.STONE);
  const hit = raycastVoxel(world, new THREE.Vector3(SX - 3.5, y + 0.5, SZ + 0.5), new THREE.Vector3(1, 0, 0), 10);
  assert.ok(hit);
  assert.strictEqual(hit.x, SX);
  assert.strictEqual(hit.nx, -1);
  world.setBlock(SX, y, SZ, B.AIR);
});

console.log('— player physics —');
// clear a drop zone above the spawn surface (trees etc.)
const groundH = world.surfaceHeight(SX, SZ);
for (let y = groundH + 1; y < groundH + 12; y++)
  for (let dx = -1; dx <= 2; dx++)
    for (let dz = -1; dz <= 1; dz++)
      world.setBlock(SX + dx, y, SZ + dz, B.AIR);

ok('player falls and lands on the surface', () => {
  const p = new Player(world);
  p.teleport(SX + 0.5, groundH + 8, SZ + 0.5);
  const input = { forward: false, back: false, left: false, right: false, jump: false, sneak: false };
  for (let i = 0; i < 600; i++) p.update(1 / 60, input);
  assert.ok(p.onGround, 'landed');
  assert.ok(Math.abs(p.pos.y - (groundH + 1)) < 0.1, `rests on surface (y=${p.pos.y}, h=${groundH})`);
});
ok('player collides with walls', () => {
  const p = new Player(world);
  // build a wall two blocks to the +x side
  world.setBlock(SX + 2, groundH + 1, SZ, B.STONE);
  world.setBlock(SX + 2, groundH + 2, SZ, B.STONE);
  p.teleport(SX + 0.5, groundH + 1, SZ + 0.5);
  const input = { forward: false, back: false, left: false, right: true, jump: false, sneak: false };
  for (let i = 0; i < 300; i++) p.update(1 / 60, input); // yaw=0 → "right" pushes +x
  assert.ok(p.pos.x < SX + 2, `stopped by wall (x=${p.pos.x})`);
  assert.ok(p.pos.x > SX + 1.5, `actually walked up to it (x=${p.pos.x})`);
  world.setBlock(SX + 2, groundH + 1, SZ, B.AIR);
  world.setBlock(SX + 2, groundH + 2, SZ, B.AIR);
});

console.log('— block geometry —');
ok('standalone geometry for every palette block', () => {
  for (const id of PALETTE) {
    const g = buildBlockGeometry(id);
    const pos = g.getAttribute('position');
    assert.ok(pos.count >= 4, `${BLOCKS[id].name} has vertices`);
    for (let i = 0; i < pos.array.length; i++) assert.ok(Number.isFinite(pos.array[i]));
  }
});

console.log(`\nAll ${passed} smoke tests passed ✔`);
