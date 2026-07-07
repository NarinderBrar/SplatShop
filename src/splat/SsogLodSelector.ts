import type { SsogBound } from "./SplatAsset";

type Vec3Like = {
  x: number;
  y: number;
  z: number;
};

type SsogSelectableItem<T> = {
  value: T;
  key: string;
  nodeId: number;
  parentNodeId?: number;
  depth: number;
  lod: number;
  count: number;
  bound: SsogBound;
  wasSelected?: boolean;
  lodScale?: number;
};

type SsogLodCandidateSoA = {
  length: number;
  nodeIds: Uint32Array;
  depths: Uint16Array;
  lods: Uint16Array;
  counts: Uint32Array;
  flags: Uint8Array;
  lodScales: Float32Array;
  bounds: Float32Array;
};

type SsogLodSelectOptions = {
  budget: number;
  cameraPosition: Vec3Like;
  cameraForward?: Vec3Like;
  focalPixels: number;
  lodRangeMin: number;
  lodRangeMax: number;
  lodUnderfillLimit: number;
  forceFineScreenRatio?: number;
  forceFineViewDot?: number;
  coneFov0Cos?: number;
  coneFovCos?: number;
  coneFoveate?: number;
  behindFoveate?: number;
};

type SsogLodSelection<T> = {
  selected: SsogSelectableItem<T>[];
  activeChunks: number;
  selectedLods: number;
  selectedSplats: number;
};

type RankValues = {
  score: number;
  screenRadius: number;
  viewDot: number;
};

const getFoveationWeight = (viewDot: number, options: SsogLodSelectOptions): number => {
  const coneFoveate = Math.max(0, Math.min(1, options.coneFoveate ?? 0));
  const behindFoveate = Math.max(0, Math.min(1, options.behindFoveate ?? 0));
  if (coneFoveate <= 0 && behindFoveate <= 0) {
    return 1;
  }

  if (viewDot <= 0) {
    return Math.max(0.01, 1 - behindFoveate);
  }

  const innerCos = Math.max(-1, Math.min(1, options.coneFov0Cos ?? 1));
  const outerCos = Math.max(-1, Math.min(1, options.coneFovCos ?? innerCos));
  const highCos = Math.max(innerCos, outerCos);
  const lowCos = Math.min(innerCos, outerCos);
  if (viewDot >= highCos) {
    return 1;
  }
  if (viewDot <= lowCos) {
    return Math.max(0.01, 1 - coneFoveate);
  }

  const t = (viewDot - lowCos) / Math.max(0.000001, highCos - lowCos);
  return Math.max(0.01, 1 - coneFoveate * (1 - t));
};

type SsogLodCandidateReader<T> = {
  length: number;
  getRank: (index: number) => RankValues;
  getNodeId: (index: number) => number;
  getDepth: (index: number) => number;
  getLod: (index: number) => number;
  getCount: (index: number) => number;
  getItem: (index: number) => SsogSelectableItem<T>;
};

type NodeSelection = {
  rankedIndex: number;
  lodIndex: number;
  lods: number[];
};

type ForcedFineUpgrade = {
  selection: NodeSelection;
  finestIndex: number;
  addedSplats: number;
  priority: number;
};

type IncrementalUpgrade = {
  selection: NodeSelection;
  nextIndex: number;
  nextLodIndex: number;
  addedSplats: number;
  score: number;
};

class SsogLodSelectorScratch<T> {
  scores = new Float64Array(0);
  screenRadii = new Float64Array(0);
  viewDots = new Float64Array(0);
  selected: SsogSelectableItem<T>[] = [];
  rankedCoverage: number[] = [];
  forcedFineUpgrades: ForcedFineUpgrade[] = [];
  incrementalUpgrades: IncrementalUpgrade[] = [];
  selectedLodValues = new Set<number>();
  selectedByNode = new Map<number, NodeSelection>();
  groupsByNode = new Map<number, number[]>();
  private groupPool: number[][] = [];
  private groupPoolUsed = 0;

  reset(itemCount: number): void {
    this.ensureCapacity(itemCount);
    this.selected.length = 0;
    this.rankedCoverage.length = 0;
    this.forcedFineUpgrades.length = 0;
    this.incrementalUpgrades.length = 0;
    this.selectedLodValues.clear();
    this.selectedByNode.clear();
    this.groupsByNode.clear();
    this.groupPoolUsed = 0;
  }

  getGroup(): number[] {
    let group = this.groupPool[this.groupPoolUsed];
    if (!group) {
      group = [];
      this.groupPool[this.groupPoolUsed] = group;
    }
    this.groupPoolUsed++;
    group.length = 0;
    return group;
  }

  private ensureCapacity(itemCount: number): void {
    if (this.scores.length >= itemCount) {
      return;
    }

    let capacity = Math.max(16, this.scores.length);
    while (capacity < itemCount) {
      capacity *= 2;
    }
    this.scores = new Float64Array(capacity);
    this.screenRadii = new Float64Array(capacity);
    this.viewDots = new Float64Array(capacity);
  }
}

const getBoundsRank = <T>(
  item: SsogSelectableItem<T>,
  options: SsogLodSelectOptions,
): RankValues => {
  const centerX = (item.bound.min[0] + item.bound.max[0]) * 0.5;
  const centerY = (item.bound.min[1] + item.bound.max[1]) * 0.5;
  const centerZ = (item.bound.min[2] + item.bound.max[2]) * 0.5;
  const radiusX = item.bound.max[0] - centerX;
  const radiusY = item.bound.max[1] - centerY;
  const radiusZ = item.bound.max[2] - centerZ;
  const radius = Math.max(0.001, Math.hypot(radiusX, radiusY, radiusZ));
  const toCenterX = centerX - options.cameraPosition.x;
  const toCenterY = centerY - options.cameraPosition.y;
  const toCenterZ = centerZ - options.cameraPosition.z;
  const distanceToCenter = Math.max(0.001, Math.hypot(toCenterX, toCenterY, toCenterZ));
  const distance = Math.max(0.001, distanceToCenter - radius);
  const screenRadius = (radius / distance) * options.focalPixels;
  const range = Math.max(0.000001, options.lodRangeMax - options.lodRangeMin);
  const normalized = Math.max(0, (screenRadius - options.lodRangeMin) / range);
  const screenBias = Math.min(4, normalized <= 1 ? normalized : 1 + Math.log2(normalized));
  const forward = options.cameraForward;
  const viewDot = forward
    ? Math.max(
        0,
        (toCenterX * forward.x + toCenterY * forward.y + toCenterZ * forward.z) / distanceToCenter,
      )
    : 0.5;
  const viewBias = 0.35 + viewDot * 0.65;
  const foveationWeight = getFoveationWeight(viewDot, options);
  const distanceBias = 1 / Math.sqrt(distanceToCenter);
  const hysteresis = item.wasSelected ? 1.15 : 1;
  const depthBias = 1 + item.depth * 0.015;
  const lodScale = Math.max(0.01, item.lodScale ?? 1);
  return {
    score: screenBias * viewBias * foveationWeight * distanceBias * Math.sqrt(item.count) * hysteresis * depthBias * lodScale,
    screenRadius,
    viewDot,
  };
};

const getBoundsRankFromSoA = (
  candidates: SsogLodCandidateSoA,
  index: number,
  options: SsogLodSelectOptions,
): RankValues => {
  const boundsOffset = index * 6;
  const minX = candidates.bounds[boundsOffset + 0];
  const minY = candidates.bounds[boundsOffset + 1];
  const minZ = candidates.bounds[boundsOffset + 2];
  const maxX = candidates.bounds[boundsOffset + 3];
  const maxY = candidates.bounds[boundsOffset + 4];
  const maxZ = candidates.bounds[boundsOffset + 5];
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  const radiusX = maxX - centerX;
  const radiusY = maxY - centerY;
  const radiusZ = maxZ - centerZ;
  const radius = Math.max(0.001, Math.hypot(radiusX, radiusY, radiusZ));
  const toCenterX = centerX - options.cameraPosition.x;
  const toCenterY = centerY - options.cameraPosition.y;
  const toCenterZ = centerZ - options.cameraPosition.z;
  const distanceToCenter = Math.max(0.001, Math.hypot(toCenterX, toCenterY, toCenterZ));
  const distance = Math.max(0.001, distanceToCenter - radius);
  const screenRadius = (radius / distance) * options.focalPixels;
  const range = Math.max(0.000001, options.lodRangeMax - options.lodRangeMin);
  const normalized = Math.max(0, (screenRadius - options.lodRangeMin) / range);
  const screenBias = Math.min(4, normalized <= 1 ? normalized : 1 + Math.log2(normalized));
  const forward = options.cameraForward;
  const viewDot = forward
    ? Math.max(
        0,
        (toCenterX * forward.x + toCenterY * forward.y + toCenterZ * forward.z) / distanceToCenter,
      )
    : 0.5;
  const viewBias = 0.35 + viewDot * 0.65;
  const foveationWeight = getFoveationWeight(viewDot, options);
  const distanceBias = 1 / Math.sqrt(distanceToCenter);
  const hysteresis = candidates.flags[index] !== 0 ? 1.15 : 1;
  const depthBias = 1 + candidates.depths[index] * 0.015;
  const lodScale = Math.max(0.01, candidates.lodScales[index] || 1);
  return {
    score: screenBias * viewBias * foveationWeight * distanceBias * Math.sqrt(candidates.counts[index]) * hysteresis * depthBias * lodScale,
    screenRadius,
    viewDot,
  };
};

const selectSsogLodWithReader = <T>(
  reader: SsogLodCandidateReader<T>,
  options: SsogLodSelectOptions,
  scratch: SsogLodSelectorScratch<T>,
): SsogLodSelection<T> => {
  scratch.reset(reader.length);
  for (let index = 0; index < reader.length; index++) {
    const rank = reader.getRank(index);
    scratch.scores[index] = rank.score;
    scratch.screenRadii[index] = rank.screenRadius;
    scratch.viewDots[index] = rank.viewDot;

    const nodeId = reader.getNodeId(index);
    let group = scratch.groupsByNode.get(nodeId);
    if (!group) {
      group = scratch.getGroup();
      scratch.groupsByNode.set(nodeId, group);
    }
    group.push(index);
  }

  const budget = Math.max(0, Math.floor(options.budget));
  const selectedByNode = scratch.selectedByNode;
  let selectedSplats = 0;

  for (const group of scratch.groupsByNode.values()) {
    group.sort((a, b) => reader.getLod(a) - reader.getLod(b) || a - b);
    const coarsestIndex = group.length - 1;
    const coarsestItemIndex = group[coarsestIndex];
    if (coarsestItemIndex === undefined) {
      continue;
    }

    selectedByNode.set(reader.getNodeId(coarsestItemIndex), {
      rankedIndex: coarsestItemIndex,
      lodIndex: coarsestIndex,
      lods: group,
    });
    selectedSplats += reader.getCount(coarsestItemIndex);
  }

  if (selectedByNode.size === 0) {
    return {
      selected: [],
      activeChunks: 0,
      selectedLods: 0,
      selectedSplats: 0,
    };
  }

  if (selectedSplats <= budget || budget <= 0) {
    const forcedFineUpgrades = scratch.forcedFineUpgrades;
    for (const selection of selectedByNode.values()) {
      const finestIndex = selection.lods[0];
      if (finestIndex === undefined || finestIndex === selection.rankedIndex) {
        continue;
      }

      const isScreenDominant =
        scratch.screenRadii[finestIndex] >= options.lodRangeMax * (options.forceFineScreenRatio ?? 0.9);
      const isStronglyVisible = scratch.viewDots[finestIndex] >= (options.forceFineViewDot ?? 0.2);
      if (!isScreenDominant || !isStronglyVisible) {
        continue;
      }

      forcedFineUpgrades.push({
        selection,
        finestIndex,
        addedSplats: reader.getCount(finestIndex) - reader.getCount(selection.rankedIndex),
        priority: scratch.screenRadii[finestIndex] * (0.5 + scratch.viewDots[finestIndex] * 0.5),
      });
    }
    forcedFineUpgrades.sort((a, b) => b.priority - a.priority || a.addedSplats - b.addedSplats);

    for (const upgrade of forcedFineUpgrades) {
      if (upgrade.addedSplats < 0) {
        continue;
      }
      if (selectedSplats + upgrade.addedSplats > budget) {
        continue;
      }

      upgrade.selection.rankedIndex = upgrade.finestIndex;
      upgrade.selection.lodIndex = 0;
      selectedSplats += upgrade.addedSplats;
    }

    let upgraded = true;
    while (upgraded) {
      upgraded = false;
      const upgrades = scratch.incrementalUpgrades;
      upgrades.length = 0;
      for (const selection of selectedByNode.values()) {
        const nextLodIndex = selection.lodIndex - 1;
        const nextIndex = selection.lods[nextLodIndex];
        if (nextIndex === undefined) {
          continue;
        }

        const nextLod = reader.getLod(nextIndex);
        const addedSplats = reader.getCount(nextIndex) - reader.getCount(selection.rankedIndex);
        if (addedSplats < 0) {
          continue;
        }

        const fineDetailBias = 1 + 0.65 / Math.max(1, nextLod + 1);
        const closeDetailBias = scratch.screenRadii[nextIndex] > options.lodRangeMax ? 1.8 : 1;
        const viewDetailBias = 0.6 + scratch.viewDots[nextIndex] * 0.4;
        const cost = Math.pow(Math.max(1, addedSplats), 0.55);
        upgrades.push({
          selection,
          nextIndex,
          nextLodIndex,
          addedSplats,
          score: (scratch.scores[nextIndex] * fineDetailBias * closeDetailBias * viewDetailBias) / cost,
        });
      }
      upgrades.sort(
        (a, b) =>
          b.score - a.score ||
          reader.getDepth(b.nextIndex) - reader.getDepth(a.nextIndex) ||
          reader.getLod(a.nextIndex) - reader.getLod(b.nextIndex),
      );

      for (const upgrade of upgrades) {
        if (selectedSplats + upgrade.addedSplats > budget) {
          continue;
        }

        upgrade.selection.rankedIndex = upgrade.nextIndex;
        upgrade.selection.lodIndex = upgrade.nextLodIndex;
        selectedSplats += upgrade.addedSplats;
        upgraded = true;
        break;
      }
    }
  } else {
    const rankedCoverage = scratch.rankedCoverage;
    for (const selection of selectedByNode.values()) {
      rankedCoverage.push(selection.rankedIndex);
    }
    rankedCoverage.sort(
      (a, b) =>
        scratch.scores[b] - scratch.scores[a] ||
        reader.getDepth(b) - reader.getDepth(a) ||
        reader.getLod(a) - reader.getLod(b) ||
        a - b,
    );
    selectedByNode.clear();
    selectedSplats = 0;
    for (const rankedIndex of rankedCoverage) {
      if (selectedSplats > 0 && selectedSplats + reader.getCount(rankedIndex) > budget) {
        continue;
      }
      const group = scratch.getGroup();
      group.push(rankedIndex);
      selectedByNode.set(reader.getNodeId(rankedIndex), { rankedIndex, lodIndex: 0, lods: group });
      selectedSplats += reader.getCount(rankedIndex);
      if (selectedSplats >= budget) {
        break;
      }
    }
  }

  const selected = scratch.selected;
  const selectedLodValues = scratch.selectedLodValues;
  for (const selection of selectedByNode.values()) {
    const item = reader.getItem(selection.rankedIndex);
    selected.push(item);
    selectedLodValues.add(reader.getLod(selection.rankedIndex));
  }
  selected.sort((a, b) => a.nodeId - b.nodeId || a.lod - b.lod);

  return {
    selected,
    activeChunks: selected.length,
    selectedLods: selectedLodValues.size,
    selectedSplats,
  };
};

const selectSsogLod = <T>(
  items: SsogSelectableItem<T>[],
  options: SsogLodSelectOptions,
  scratch = new SsogLodSelectorScratch<T>(),
): SsogLodSelection<T> =>
  selectSsogLodWithReader(
    {
      length: items.length,
      getRank: (index) => getBoundsRank(items[index], options),
      getNodeId: (index) => items[index].nodeId,
      getDepth: (index) => items[index].depth,
      getLod: (index) => items[index].lod,
      getCount: (index) => items[index].count,
      getItem: (index) => items[index],
    },
    options,
    scratch,
  );

const selectSsogLodFromSoA = <T>(
  candidates: SsogLodCandidateSoA,
  items: SsogSelectableItem<T>[],
  options: SsogLodSelectOptions,
  scratch = new SsogLodSelectorScratch<T>(),
): SsogLodSelection<T> =>
  selectSsogLodWithReader(
    {
      length: candidates.length,
      getRank: (index) => getBoundsRankFromSoA(candidates, index, options),
      getNodeId: (index) => candidates.nodeIds[index],
      getDepth: (index) => candidates.depths[index],
      getLod: (index) => candidates.lods[index],
      getCount: (index) => candidates.counts[index],
      getItem: (index) => items[index],
    },
    options,
    scratch,
  );

export { selectSsogLod, selectSsogLodFromSoA, SsogLodSelectorScratch };
export type { SsogSelectableItem, SsogLodCandidateSoA, SsogLodSelection, SsogLodSelectOptions };
