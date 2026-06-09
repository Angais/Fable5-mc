# Voxel Game Test

> **Disclaimer:** Voxel Game Test is not related to, endorsed by, sponsored by, or affiliated with Microsoft, Mojang, or Minecraft. This is a non-commercial test project made for learning and experimentation under fair use.

A faithful Minecraft clone that runs entirely in the browser with [Three.js](https://threejs.org/).
No build step, no image or sound assets — every texture is procedurally painted onto canvases
at startup and every sound is synthesized with WebAudio.

![Genre](https://img.shields.io/badge/genre-voxel%20sandbox-green) ![Engine](https://img.shields.io/badge/engine-three.js-blue)

## Running

The game is plain static HTML + ES modules (Three.js comes from a CDN import map), so any
static file server works:

```bash
npm start            # serves on http://localhost:5173
# or: python3 -m http.server 8000
# or: any dev server already serving this folder — just open index.html through it
```

> Opening `index.html` directly from disk (`file://`) won't work — ES modules require HTTP.

Optional, for the node smoke tests only:

```bash
npm install && npm test
```

## Features

### World
- **Infinite procedural terrain** — seeded simplex noise: continents, hills, ridged mountains
- **Biomes**: plains, forest, desert (cacti, dead bushes), snowy tundra (spruces, frozen oceans), mountains (snow caps), oceans & beaches
- **Caves** — "spaghetti" tunnels + deep caverns carved with trilinearly-interpolated 3D noise (the same trick real Minecraft uses)
- **Ore veins** — coal, iron, gold, redstone, diamond, each with authentic depth ranges
- **Decorations** — oak & spruce trees (they cross chunk borders correctly), flowers, tall grass, pumpkins, sugar-free cacti
- **Day/night cycle** (20 minutes) with square sun & moon, star dome, sunrise/sunset tints, drifting blocky clouds and matching fog
- **Chunk streaming** — 16×128×16 chunks generate/mesh/unload around you with a per-frame time budget

### Rendering
- Hidden-face culling, per-vertex **ambient occlusion** with quad-flipping, Minecraft's directional face shading
- **Smooth lighting** — skylight darkens with depth (caves are genuinely dark), **torches** cast warm light, all baked into vertex colors and modulated by a day/night shader uniform
- Water with lowered surface, animated texture, underwater fog & overlay
- Cross-meshes for plants (with positional jitter), tiny 3D torch model, biome-tinted grass
- Block-breaking **crack overlay**, black target outline, digging particles that sample the block's texture

### Gameplay
- First-person controller with Minecraft-tuned physics: walking 4.3 m/s, sprinting (+FOV kick), sneaking **with edge protection**, swimming, creative **flying** (double-tap SPACE)
- Hold-to-mine with per-block hardness; bedrock is unbreakable
- Block placing with support rules (torches need floors, cacti need sand…), can't place inside yourself
- **Falling sand & gravel**, chained support breaking (snap a flower's block and it pops)
- **TNT** — break it to ignite: fuse blink, explosion crater, knockback, camera shake, chain reactions
- 9-slot hotbar (1–9 / mouse wheel), middle-click pick-block, **E** opens a creative block picker with 35 block types
- World persistence — seed, your edits, position and time of day save to `localStorage` automatically
- F3 debug screen, pause menu, options (render distance, FOV, sensitivity, volume, bobbing, clouds, music, smooth lighting)

### Audio
- Synthesized digging/placing/footsteps per material, glass pings, splashes, TNT boom with sub-bass
- A generative ambient music box that noodles a soft pentatonic phrase every now and then

## Controls

| Action | Key |
|---|---|
| Move | W A S D |
| Jump / swim up | SPACE |
| Sneak / fly down | SHIFT |
| Sprint | CTRL or double-tap W |
| Toggle fly | Double-tap SPACE (or F) |
| Break block | Hold LEFT CLICK |
| Place block | RIGHT CLICK |
| Pick block | MIDDLE CLICK |
| Hotbar | 1–9 or mouse wheel |
| Block picker | E |
| Debug | F3 |
| Pause | ESC |

## Architecture

```
index.html        UI overlay markup + import map
style.css         Minecraft-flavored UI chrome
src/
  noise.js        seeded PRNG, hashes, simplex noise (2D/3D), fbm
  textures.js     procedural 16×16 tile painters → texture atlas, cracks, sun/moon/clouds/water
  blocks.js       block registry: per-face tiles, physics flags, hardness, sounds
  worldgen.js     biomes, terrain shaping, caves, ores, trees, decorations, skylight heightmap
  mesher.js       chunk → BufferGeometry: culling, AO, smooth light, liquids, crosses, torches
  world.js        chunk store, streaming queues, edits, torch tracking, persistence
  player.js       AABB voxel physics, swimming, flying, sneak-guard + DDA raycast
  sky.js          day/night cycle, sun/moon/stars, clouds, fog
  particles.js    pooled billboard digging/explosion particles (1 draw call)
  audio.js        WebAudio synth: materials, explosions, generative music
  entities.js     falling blocks, primed TNT, explosions
  ui.js           DOM: title, hotbar, picker, menus, F3 overlay
  main.js         game state machine, input, mining/placing, held block, save/load, loop
```

## Deliberate scope cuts

No mobs, no item drops/inventory survival economy (it plays like creative with timed mining),
no water flow simulation, no redstone. Torch light is distance-based (it can bleed through
thin walls), and skylight uses a heightmap rather than flood-fill.
