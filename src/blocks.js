// ============================================================
// Block registry — ids, per-face textures, physics flags,
// hardness, sounds. Pure data (no three.js import) so it can
// be unit-tested in node.
// ============================================================

export const B = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  COBBLE: 4,
  BEDROCK: 5,
  SAND: 6,
  GRAVEL: 7,
  LOG: 8,
  PLANKS: 9,
  LEAVES: 10,
  GLASS: 11,
  WATER: 12,
  SANDSTONE: 13,
  SNOW_GRASS: 14,
  SNOW_BLOCK: 15,
  ICE: 16,
  CACTUS: 17,
  SPRUCE_LOG: 18,
  SPRUCE_LEAVES: 19,
  BRICKS: 20,
  STONEBRICK: 21,
  BOOKSHELF: 22,
  OBSIDIAN: 23,
  TNT: 24,
  PUMPKIN: 25,
  COAL_ORE: 26,
  IRON_ORE: 27,
  GOLD_ORE: 28,
  DIAMOND_ORE: 29,
  REDSTONE_ORE: 30,
  FLOWER_RED: 31,
  FLOWER_YELLOW: 32,
  TALLGRASS: 33,
  DEADBUSH: 34,
  TORCH: 35,
};

// face keys: px (+x east), nx (west), py (top), ny (bottom), pz (south), nz (north)
const FACE_KEYS = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

function expandTex(tex) {
  if (!tex) return null;
  const out = {};
  for (const k of FACE_KEYS) {
    out[k] =
      tex[k] ??
      (k === 'py' ? tex.top : k === 'ny' ? tex.bottom : tex.side) ??
      tex.all;
  }
  return out;
}

/**
 * def fields:
 *  name          display name
 *  tex           per-face tile names ({all} | {top,bottom,side} | per-face)
 *  shape         'cube' | 'cross' | 'liquid' | 'torch'
 *  solid         player collision
 *  opaque        full opaque cube (culls neighbor faces, occludes AO)
 *  cullSame      hide faces between two blocks of the same id
 *  aoCast        contributes to ambient occlusion
 *  countsHeight  blocks skylight column (cave darkness)
 *  hardness      seconds to mine (Infinity = unbreakable)
 *  sound         'stone'|'dirt'|'grass'|'sand'|'wood'|'glass'|'snow'
 *  replaceable   placing a block into this cell replaces it
 *  gravity       falls when unsupported (sand/gravel)
 *  support       'floor' needs solid below, 'sand' cactus rule
 *  light         emits light 0..1 (torch)
 */
function def(id, props) {
  const d = {
    id,
    name: 'Block',
    tex: null,
    shape: 'cube',
    solid: true,
    opaque: true,
    cullSame: false,
    aoCast: true,
    countsHeight: true,
    hardness: 0.5,
    sound: 'stone',
    replaceable: false,
    gravity: false,
    support: null,
    light: 0,
    ...props,
  };
  d.tex = expandTex(d.tex);
  return d;
}

const cross = (props) => ({
  shape: 'cross',
  solid: false,
  opaque: false,
  aoCast: false,
  countsHeight: false,
  hardness: 0.05,
  sound: 'grass',
  support: 'floor',
  ...props,
});

export const BLOCKS = [];

BLOCKS[B.AIR] = def(B.AIR, { name: 'Air', solid: false, opaque: false, aoCast: false, countsHeight: false, tex: null });
BLOCKS[B.GRASS] = def(B.GRASS, { name: 'Grass Block', tex: { top: 'grass_top', bottom: 'dirt', side: 'grass_side' }, hardness: 0.4, sound: 'grass' });
BLOCKS[B.DIRT] = def(B.DIRT, { name: 'Dirt', tex: { all: 'dirt' }, hardness: 0.35, sound: 'dirt' });
BLOCKS[B.STONE] = def(B.STONE, { name: 'Stone', tex: { all: 'stone' }, hardness: 0.75 });
BLOCKS[B.COBBLE] = def(B.COBBLE, { name: 'Cobblestone', tex: { all: 'cobble' }, hardness: 0.8 });
BLOCKS[B.BEDROCK] = def(B.BEDROCK, { name: 'Bedrock', tex: { all: 'bedrock' }, hardness: Infinity });
BLOCKS[B.SAND] = def(B.SAND, { name: 'Sand', tex: { all: 'sand' }, hardness: 0.3, sound: 'sand', gravity: true });
BLOCKS[B.GRAVEL] = def(B.GRAVEL, { name: 'Gravel', tex: { all: 'gravel' }, hardness: 0.35, sound: 'sand', gravity: true });
BLOCKS[B.LOG] = def(B.LOG, { name: 'Oak Log', tex: { top: 'log_top', bottom: 'log_top', side: 'log_side' }, hardness: 0.6, sound: 'wood', countsHeight: false });
BLOCKS[B.PLANKS] = def(B.PLANKS, { name: 'Oak Planks', tex: { all: 'planks' }, hardness: 0.55, sound: 'wood' });
BLOCKS[B.LEAVES] = def(B.LEAVES, { name: 'Oak Leaves', tex: { all: 'leaves' }, opaque: false, cullSame: true, hardness: 0.15, sound: 'grass', countsHeight: false });
BLOCKS[B.GLASS] = def(B.GLASS, { name: 'Glass', tex: { all: 'glass' }, opaque: false, cullSame: true, aoCast: false, countsHeight: false, hardness: 0.2, sound: 'glass' });
BLOCKS[B.WATER] = def(B.WATER, {
  name: 'Water', tex: { all: 'water_still' }, shape: 'liquid', solid: false, opaque: false,
  cullSame: true, aoCast: false, countsHeight: false, hardness: Infinity, replaceable: true,
});
BLOCKS[B.SANDSTONE] = def(B.SANDSTONE, { name: 'Sandstone', tex: { top: 'sandstone_top', bottom: 'sandstone_top', side: 'sandstone_side' }, hardness: 0.7 });
BLOCKS[B.SNOW_GRASS] = def(B.SNOW_GRASS, { name: 'Snowy Grass', tex: { top: 'snow', bottom: 'dirt', side: 'grass_side_snow' }, hardness: 0.4, sound: 'snow' });
BLOCKS[B.SNOW_BLOCK] = def(B.SNOW_BLOCK, { name: 'Snow Block', tex: { all: 'snow' }, hardness: 0.25, sound: 'snow' });
BLOCKS[B.ICE] = def(B.ICE, { name: 'Ice', tex: { all: 'ice' }, hardness: 0.35, sound: 'glass' });
BLOCKS[B.CACTUS] = def(B.CACTUS, { name: 'Cactus', tex: { top: 'cactus_top', bottom: 'cactus_top', side: 'cactus_side' }, hardness: 0.3, sound: 'grass', support: 'sand', countsHeight: false });
BLOCKS[B.SPRUCE_LOG] = def(B.SPRUCE_LOG, { name: 'Spruce Log', tex: { top: 'spruce_log_top', bottom: 'spruce_log_top', side: 'spruce_log_side' }, hardness: 0.6, sound: 'wood', countsHeight: false });
BLOCKS[B.SPRUCE_LEAVES] = def(B.SPRUCE_LEAVES, { name: 'Spruce Leaves', tex: { all: 'leaves_spruce' }, opaque: false, cullSame: true, hardness: 0.15, sound: 'grass', countsHeight: false });
BLOCKS[B.BRICKS] = def(B.BRICKS, { name: 'Bricks', tex: { all: 'bricks' }, hardness: 0.85 });
BLOCKS[B.STONEBRICK] = def(B.STONEBRICK, { name: 'Stone Bricks', tex: { all: 'stonebrick' }, hardness: 0.8 });
BLOCKS[B.BOOKSHELF] = def(B.BOOKSHELF, { name: 'Bookshelf', tex: { top: 'planks', bottom: 'planks', side: 'bookshelf' }, hardness: 0.5, sound: 'wood' });
BLOCKS[B.OBSIDIAN] = def(B.OBSIDIAN, { name: 'Obsidian', tex: { all: 'obsidian' }, hardness: 2.6 });
BLOCKS[B.TNT] = def(B.TNT, { name: 'TNT', tex: { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' }, hardness: 0.05, sound: 'grass' });
BLOCKS[B.PUMPKIN] = def(B.PUMPKIN, { name: 'Pumpkin', tex: { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side', pz: 'pumpkin_face' }, hardness: 0.45, sound: 'wood' });
BLOCKS[B.COAL_ORE] = def(B.COAL_ORE, { name: 'Coal Ore', tex: { all: 'coal_ore' }, hardness: 0.9 });
BLOCKS[B.IRON_ORE] = def(B.IRON_ORE, { name: 'Iron Ore', tex: { all: 'iron_ore' }, hardness: 1.0 });
BLOCKS[B.GOLD_ORE] = def(B.GOLD_ORE, { name: 'Gold Ore', tex: { all: 'gold_ore' }, hardness: 1.0 });
BLOCKS[B.DIAMOND_ORE] = def(B.DIAMOND_ORE, { name: 'Diamond Ore', tex: { all: 'diamond_ore' }, hardness: 1.1 });
BLOCKS[B.REDSTONE_ORE] = def(B.REDSTONE_ORE, { name: 'Redstone Ore', tex: { all: 'redstone_ore' }, hardness: 1.0 });
BLOCKS[B.FLOWER_RED] = def(B.FLOWER_RED, cross({ name: 'Poppy', tex: { all: 'flower_red' } }));
BLOCKS[B.FLOWER_YELLOW] = def(B.FLOWER_YELLOW, cross({ name: 'Dandelion', tex: { all: 'flower_yellow' } }));
BLOCKS[B.TALLGRASS] = def(B.TALLGRASS, cross({ name: 'Tall Grass', tex: { all: 'tallgrass' }, replaceable: true }));
BLOCKS[B.DEADBUSH] = def(B.DEADBUSH, cross({ name: 'Dead Bush', tex: { all: 'deadbush' }, replaceable: true, sound: 'wood' }));
BLOCKS[B.TORCH] = def(B.TORCH, {
  name: 'Torch', tex: { all: 'torch' }, shape: 'torch', solid: false, opaque: false,
  aoCast: false, countsHeight: false, hardness: 0.05, sound: 'wood', support: 'floor', light: 1,
});

export const blockDef = (id) => BLOCKS[id] || BLOCKS[B.AIR];
export const isSolid = (id) => BLOCKS[id]?.solid ?? false;
export const isOpaque = (id) => BLOCKS[id]?.opaque ?? false;

/** Blocks shown in the inventory picker (E). */
export const PALETTE = [
  B.GRASS, B.DIRT, B.STONE, B.COBBLE, B.STONEBRICK, B.BRICKS, B.PLANKS, B.LOG, B.BOOKSHELF,
  B.LEAVES, B.SPRUCE_LOG, B.SPRUCE_LEAVES, B.SAND, B.SANDSTONE, B.GRAVEL, B.GLASS, B.ICE, B.SNOW_BLOCK,
  B.SNOW_GRASS, B.OBSIDIAN, B.BEDROCK, B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.REDSTONE_ORE, B.DIAMOND_ORE, B.WATER,
  B.CACTUS, B.PUMPKIN, B.TNT, B.TORCH, B.FLOWER_RED, B.FLOWER_YELLOW, B.TALLGRASS, B.DEADBUSH,
];

export const DEFAULT_HOTBAR = [B.GRASS, B.DIRT, B.STONE, B.LOG, B.PLANKS, B.GLASS, B.SAND, B.TNT, B.TORCH];
