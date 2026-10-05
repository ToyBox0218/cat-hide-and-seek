'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Palette = require('../region-palette.js');
const Battle = require('../battle-engine.js');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'region-palette.js'), 'utf8');
const floors = { 6: 0.1478, 12: 0.0995, 20: 0.0792, 24: 0.0762 };

function stripes(size, id = `stripes-${size}`) {
  return { size, id, regions: Array.from({ length: size * size }, (_, index) => Math.floor(index / size)) };
}
function blocks(size) {
  const columns = size === 6 ? 3 : size === 12 ? 4 : size === 20 ? 5 : 6;
  const rows = size / columns;
  return { size, id: `blocks-${size}`, regions: Array.from({ length: size * size }, (_, index) =>
    Math.floor(Math.floor(index / size) * rows / size) * columns + Math.floor((index % size) * columns / size)) };
}
function seeded(seed) { return () => { seed = Math.imul(seed, 1664525) + 1013904223; return (seed >>> 0) / 0x100000000; }; }
function browserPalette() {
  const context = vm.createContext({});
  vm.runInContext('Math.random = () => { throw Error("No random colors"); }; Date = class { constructor() { throw Error("No clock colors"); } static now() { throw Error("No clock colors"); } };', context);
  vm.runInContext(SOURCE, context, { filename: 'region-palette.js' });
  return context.CatPalette;
}
function independentContrast(hex, ink) {
  const luminance = value => value.match(/[\da-f]{2}/gi).map(component => parseInt(component, 16) / 255)
    .map(component => component <= 0.04045 ? component / 12.92 : Math.pow((component + 0.055) / 1.055, 2.4))
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  return (luminance(hex) + 0.05) / (luminance(ink) + 0.05);
}

for (const size of Palette.supportedSizes) {
  test(`${size} regions have ${size} globally unique colors, including nonadjacent regions`, () => {
    for (const puzzle of [stripes(size), blocks(size)]) {
      const palette = Palette.build(puzzle);
      assert.equal(palette.length, size);
      assert.equal(new Set(palette).size, size);
      assert.ok(palette.every(color => /^#[\da-f]{6}$/.test(color)));
      assert.deepEqual([...palette].sort(), Palette.colors.slice(0, size).sort());
      const metrics = Palette.metrics(puzzle);
      assert.ok(metrics.minPairwiseDistance >= floors[size], `${size}: ${metrics.minPairwiseDistance}`);
      assert.equal(metrics.uniqueColors, size);
      assert.ok(metrics.minAdjacentDistance >= metrics.minPairwiseDistance);
    }
  });

  test(`${size} region palette uses perceptual hue, lightness and chroma tiers`, () => {
    const palette = Palette.build(stripes(size));
    const metrics = Palette.metrics(stripes(size));
    assert.ok(metrics.lightnessRange[1] - metrics.lightnessRange[0] >= 0.15);
    assert.ok(metrics.chromaRange[1] - metrics.chromaRange[0] >= 0.09);
    assert.ok(metrics.lightnessRange[0] >= 0.765 && metrics.lightnessRange[1] <= 0.94);
    for (const ink of ['#4d423b', '#493d35']) {
      assert.ok(palette.every(color => independentContrast(color, ink) >= 4.6));
      assert.ok(Palette.metrics(stripes(size), palette, ink).minInkContrast >= 4.6);
    }
  });

  test(`${size} region assignment improves adjacent separation over the unordered prefix`, () => {
    for (const puzzle of [stripes(size), blocks(size)]) {
      const optimized = Palette.metrics(puzzle);
      const plain = Palette.metrics(puzzle, Palette.colors.slice(0, size));
      assert.ok(optimized.minAdjacentDistance > plain.minAdjacentDistance + 0.001,
        `${size}: optimized ${optimized.minAdjacentDistance}; plain ${plain.minAdjacentDistance}`);
    }
  });
}

test('full 24-color numerical measurements are reproducible', () => {
  const result = Palette.metrics(stripes(24));
  assert.ok(Math.abs(result.minPairwiseDistance - 0.07628140429845548) < 1e-12);
  assert.ok(Math.abs(result.minInkContrast - 4.6077735854456785) < 1e-12);
  assert.ok(Math.abs(Palette.contrastRatio('#ffffff', '#000000') - 21) < 1e-12);
  assert.ok(Palette.distance('#ffffff', '#000000') > 0.9999999);
  assert.deepEqual(Palette.toOKLab('#000000'), [0, 0, 0]);
});

test('yellow, cream, honey and olive use distinguishable tiers rather than repeated near-yellows', () => {
  const warmColors = Palette.colors.filter(color => {
    const [, a, b] = Palette.toOKLab(color);
    const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    return hue >= 60 && hue <= 120;
  });
  assert.equal(warmColors.length, 6);
  for (let first = 0; first < warmColors.length - 1; first++) {
    for (let second = first + 1; second < warmColors.length; second++) {
      assert.ok(Palette.distance(warmColors[first], warmColors[second]) >= 0.0792);
    }
  }
});

test('public-only snapshots and host boards produce identical colors, with no answer reads', () => {
  const publicPuzzle = blocks(24);
  const hostPuzzle = { ...publicPuzzle, regions: publicPuzzle.regions.slice() };
  for (const privateKey of ['solution', 'answers', 'history', 'found', 'misses']) {
    Object.defineProperty(hostPuzzle, privateKey, { enumerable: true, get() { throw Error(`Read private ${privateKey}`); } });
  }
  const freshBrowser = browserPalette();
  assert.deepEqual(Array.from(freshBrowser.build(hostPuzzle)), Palette.build(publicPuzzle));
  assert.deepEqual(Array.from(freshBrowser.build(JSON.parse(JSON.stringify(publicPuzzle)))), Palette.build(publicPuzzle));
});

test('peers, reconnects and independent module instances share deterministic colors without clocks or randomness', () => {
  const peerOne = browserPalette(), peerTwo = browserPalette();
  for (const size of Palette.supportedSizes) {
    const original = blocks(size);
    const reconnect = { regions: original.regions.slice(), id: original.id, size: original.size, solution: [] };
    assert.deepEqual(Array.from(peerOne.build(original)), Array.from(peerTwo.build(reconnect)));
    assert.deepEqual(Array.from(peerOne.build(original)), Palette.build(reconnect));
  }
});

test('same id with different public regions does not return a stale cached layout', () => {
  const first = stripes(24, 'reused-id'), second = { ...blocks(24), id: 'reused-id' };
  const before = Palette.build(first);
  const changed = Palette.build(second);
  assert.notStrictEqual(before, changed);
  assert.deepEqual(changed, Array.from(browserPalette().build(second)));
  assert.strictEqual(Palette.build(first), before);
});

test('cached palettes and puzzle inputs cannot be accidentally mutated', () => {
  const puzzle = blocks(20), before = JSON.stringify(puzzle);
  const colors = Palette.build(puzzle);
  assert.equal(JSON.stringify(puzzle), before);
  assert.ok(Object.isFrozen(colors));
  assert.throws(() => { colors[0] = '#000000'; }, TypeError);
  assert.equal(Palette.build(puzzle)[0], colors[0]);
  assert.ok(Object.isFrozen(Palette.colors));
});

test('many independently generated battle boards retain all six colors and safe text contrast', () => {
  const random = seeded(0xabcdef12);
  for (let index = 0; index < 30; index++) {
    const puzzle = Battle.generatePuzzle(random);
    const publicPuzzle = { id: puzzle.id, size: puzzle.size, regions: puzzle.regions.slice() };
    const hostColors = Palette.build(puzzle), guestColors = Array.from(browserPalette().build(publicPuzzle));
    assert.deepEqual(hostColors, guestColors);
    assert.equal(new Set(hostColors).size, 6);
    assert.ok(Palette.metrics(publicPuzzle).minInkContrast >= 4.6);
  }
});

test('invalid region data fails explicitly rather than recycling or silently assigning undefined colors', () => {
  assert.throws(() => Palette.build(stripes(25)), /Supported region counts/);
  assert.throws(() => Palette.build({ ...stripes(6), regions: [0, 1] }), /complete/);
  assert.throws(() => Palette.build({ ...stripes(6), regions: Array(36).fill(0) }), /complete/);
  assert.throws(() => Palette.build({ ...stripes(6), regions: Array.from({ length: 36 }, (_, index) => index % 6 === 0 ? -1 : index % 6) }), /complete/);
  const sparse = stripes(6); delete sparse.regions[0];
  assert.throws(() => Palette.build(sparse), /complete/);
});
