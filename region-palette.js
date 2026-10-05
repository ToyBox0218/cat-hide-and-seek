/* Unique, deterministic region colors. Pure public-board data; no DOM or answers. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatPalette = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Offline maximin / farthest-point selection in OKLab, from quantized sRGB.
  // Candidate constraints: L 0.765–0.940, C 0.035–0.155, and >= 4.60:1
  // WCAG relative-luminance contrast against #4d423b. Prefixes are intentional:
  // fewer regions get the most separated colors, not a hue-wheel truncation.
  // Full 24-color measured minimum distance: 0.0762814043 (OKLab units).
  // These are useful checks, not a guarantee of color-vision accessibility.
  // Strong region boundaries and non-color state marks must remain in the UI.
  const COLORS = Object.freeze([
    '#f1ce79', '#e297f6', '#60d8fb', '#60ce7e', '#fbd8fb', '#fb9792',
    '#92fbc4', '#b5b597', '#9cb0f6', '#e7f674', '#d8bad3', '#baf1fb',
    '#b0dd6a', '#fbe7c4', '#8dd8ba', '#e7a660', '#fbb5fb', '#83bfc9',
    '#fbbaa1', '#c4bf60', '#b5d3fb', '#60f6f6', '#fb97c9', '#ced8ba'
  ]);
  const INK = '#4d423b';
  const SUPPORTED_SIZES = Object.freeze([6, 12, 20, 24]);
  const CACHE_LIMIT = 64;
  const cache = new Map();

  function linearRGB(hex) {
    if (typeof hex !== 'string' || !/^#[\da-f]{6}$/i.test(hex)) throw new TypeError('Expected an sRGB #rrggbb color');
    return [1, 3, 5].map(at => {
      const component = parseInt(hex.slice(at, at + 2), 16) / 255;
      return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
    });
  }

  function toOKLab(hex) {
    const [r, g, b] = linearRGB(hex);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    ];
  }

  function distance(a, b) {
    const first = toOKLab(a), second = toOKLab(b);
    return Math.hypot(...first.map((value, index) => value - second[index]));
  }

  function luminance(hex) {
    const [r, g, b] = linearRGB(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastRatio(a, b) {
    const first = luminance(a), second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }

  const DISTANCES = COLORS.map(first => COLORS.map(second => distance(first, second)));

  function publicBoard(puzzle) {
    if (!puzzle || !SUPPORTED_SIZES.includes(puzzle.size)) throw new RangeError('Supported region counts are 6, 12, 20, and 24');
    const size = puzzle.size, regions = puzzle.regions;
    if (!Array.isArray(regions) || regions.length !== size * size ||
        Array.from(regions).some(region => !Number.isInteger(region) || region < 0 || region >= size) ||
        new Set(regions).size !== size) throw new TypeError('Expected a complete, zero-indexed region grid');
    // Never stringify the puzzle: a host puzzle also contains private answers.
    return { size, regions, key: JSON.stringify([size, String(puzzle.id ?? ''), regions]) };
  }

  function graph(board) {
    const { size, regions } = board;
    const neighbors = Array.from({ length: size }, () => new Set());
    const boundaryCounts = new Map();
    for (let index = 0; index < regions.length; index++) {
      const region = regions[index], column = index % size;
      for (const next of [column + 1 < size ? index + 1 : -1, index + size < regions.length ? index + size : -1]) {
        if (next < 0 || regions[next] === region) continue;
        const other = regions[next], low = Math.min(region, other), high = Math.max(region, other);
        neighbors[region].add(other); neighbors[other].add(region);
        const key = low * size + high;
        boundaryCounts.set(key, (boundaryCounts.get(key) || 0) + 1);
      }
    }
    const edges = [...boundaryCounts].sort((a, b) => a[0] - b[0])
      .map(([key, weight]) => [Math.floor(key / size), key % size, weight]);
    return { neighbors, edges };
  }

  function hash(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
    return result >>> 0;
  }

  // Lexicographically maximize edge distances, starting with the weakest edge.
  // Shared-boundary length is only a final tie breaker; a small region still
  // deserves a clearly separated neighbor. Every assignment is a permutation.
  function quality(assignment, edges) {
    let boundaryTotal = 0;
    const distances = edges.map(([first, second, weight]) => {
      const value = DISTANCES[assignment[first]][assignment[second]];
      boundaryTotal += value * weight;
      return value;
    }).sort((a, b) => a - b);
    distances.push(boundaryTotal);
    return distances;
  }

  function better(first, second) {
    for (let index = 0; index < first.length; index++) {
      if (Math.abs(first[index] - second[index]) > 1e-12) return first[index] > second[index];
    }
    return false;
  }

  function assign(board, structure) {
    const { size, key } = board, { neighbors, edges } = structure;
    const seed = hash(key);
    const colorOrder = Array.from({ length: size }, (_, index) => (index + seed % size) % size);
    const regionRank = Array.from({ length: size }, (_, index) => hash(`${seed}:${index}`));
    const assignment = Array(size).fill(-1), remaining = new Set(colorOrder);
    for (let count = 0; count < size; count++) {
      let region = -1, mostAssigned = -1;
      for (let current = 0; current < size; current++) {
        if (assignment[current] !== -1) continue;
        const assignedCount = [...neighbors[current]].filter(other => assignment[other] !== -1).length;
        if (region === -1 || assignedCount > mostAssigned ||
            (assignedCount === mostAssigned && neighbors[current].size > neighbors[region].size) ||
            (assignedCount === mostAssigned && neighbors[current].size === neighbors[region].size && regionRank[current] < regionRank[region])) {
          region = current; mostAssigned = assignedCount;
        }
      }
      let selected = -1, bestMinimum = -1, bestTotal = -1;
      for (const candidate of remaining) {
        const distances = [...neighbors[region]].filter(other => assignment[other] !== -1)
          .map(other => DISTANCES[candidate][assignment[other]]);
        const minimum = distances.length ? Math.min(...distances) : 0;
        const total = distances.reduce((sum, value) => sum + value, 0);
        if (minimum > bestMinimum + 1e-12 || (Math.abs(minimum - bestMinimum) <= 1e-12 && total > bestTotal + 1e-12)) {
          selected = candidate; bestMinimum = minimum; bestTotal = total;
        }
      }
      assignment[region] = selected; remaining.delete(selected);
    }

    // Compare the stable plain fill as well so graph optimization never starts
    // worse than that baseline. Deterministic local swaps improve bottlenecks.
    let result = assignment, score = quality(result, edges);
    const plainScore = quality(colorOrder, edges);
    if (better(plainScore, score)) { result = colorOrder.slice(); score = plainScore; }
    for (let pass = 0; pass < size; pass++) {
      let bestPair = null, bestScore = score;
      for (let first = 0; first < size - 1; first++) {
        for (let second = first + 1; second < size; second++) {
          [result[first], result[second]] = [result[second], result[first]];
          const candidateScore = quality(result, edges);
          [result[first], result[second]] = [result[second], result[first]];
          if (better(candidateScore, bestScore)) { bestPair = [first, second]; bestScore = candidateScore; }
        }
      }
      if (!bestPair) break;
      const [first, second] = bestPair;
      [result[first], result[second]] = [result[second], result[first]];
      score = bestScore;
    }
    return Object.freeze(result.map(index => COLORS[index]));
  }

  function build(puzzle) {
    const board = publicBoard(puzzle);
    if (cache.has(board.key)) return cache.get(board.key);
    const result = assign(board, graph(board));
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(board.key, result);
    return result;
  }

  function metrics(puzzle, palette = build(puzzle), ink = INK) {
    const board = publicBoard(puzzle), { edges } = graph(board);
    if (!Array.isArray(palette) || palette.length !== board.size) throw new TypeError('Expected one color for each region');
    let minPairwiseDistance = Infinity, closestPair = null;
    for (let first = 0; first < palette.length - 1; first++) {
      for (let second = first + 1; second < palette.length; second++) {
        const value = distance(palette[first], palette[second]);
        if (value < minPairwiseDistance) { minPairwiseDistance = value; closestPair = [first, second]; }
      }
    }
    const labs = palette.map(toOKLab);
    return {
      regionCount: board.size,
      uniqueColors: new Set(palette).size,
      minPairwiseDistance,
      closestPair,
      minAdjacentDistance: edges.length ? Math.min(...edges.map(([first, second]) => distance(palette[first], palette[second]))) : null,
      minInkContrast: Math.min(...palette.map(color => contrastRatio(color, ink))),
      ink,
      lightnessRange: [Math.min(...labs.map(lab => lab[0])), Math.max(...labs.map(lab => lab[0]))],
      chromaRange: [Math.min(...labs.map(lab => Math.hypot(lab[1], lab[2]))), Math.max(...labs.map(lab => Math.hypot(lab[1], lab[2])))]
    };
  }

  return Object.freeze({ build, metrics, colors: COLORS, ink: INK, supportedSizes: SUPPORTED_SIZES, toOKLab, distance, contrastRatio });
});
