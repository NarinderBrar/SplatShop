import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import type { SsogBound } from "./SplatAsset";

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
};

type SsogLodSelectOptions = {
  budget: number;
  cameraPosition: Vector3;
  cameraForward?: Vector3;
  focalPixels: number;
  lodRangeMin: number;
  lodRangeMax: number;
  lodUnderfillLimit: number;
  forceFineScreenRatio?: number;
  forceFineViewDot?: number;
};

type SsogLodSelection<T> = {
  selected: SsogSelectableItem<T>[];
  activeChunks: number;
  selectedLods: number;
  selectedSplats: number;
};

type RankedItem<T> = {
  item: SsogSelectableItem<T>;
  score: number;
  screenRadius: number;
  viewDot: number;
  index: number;
};

type NodeSelection<T> = {
  ranked: RankedItem<T>;
  lodIndex: number;
  lods: RankedItem<T>[];
};

const getBoundsRank = <T>(
  item: SsogSelectableItem<T>,
  options: SsogLodSelectOptions,
): Pick<RankedItem<T>, "score" | "screenRadius" | "viewDot"> => {
  const min = Vector3.FromArray(item.bound.min);
  const max = Vector3.FromArray(item.bound.max);
  const center = min.add(max).scaleInPlace(0.5);
  const radius = Math.max(0.001, Vector3.Distance(center, max));
  const toCenter = center.subtract(options.cameraPosition);
  const distanceToCenter = Math.max(0.001, toCenter.length());
  const distance = Math.max(0.001, distanceToCenter - radius);
  const screenRadius = (radius / distance) * options.focalPixels;
  const range = Math.max(0.000001, options.lodRangeMax - options.lodRangeMin);
  const normalized = Math.max(0, (screenRadius - options.lodRangeMin) / range);
  const screenBias = Math.min(4, normalized <= 1 ? normalized : 1 + Math.log2(normalized));
  const forward = options.cameraForward;
  const viewDot = forward ? Math.max(0, Vector3.Dot(toCenter.normalize(), forward)) : 0.5;
  const viewBias = 0.35 + viewDot * 0.65;
  const distanceBias = 1 / Math.sqrt(distanceToCenter);
  const hysteresis = item.wasSelected ? 1.15 : 1;
  const depthBias = 1 + item.depth * 0.015;
  return {
    score: screenBias * viewBias * distanceBias * Math.sqrt(item.count) * hysteresis * depthBias,
    screenRadius,
    viewDot,
  };
};

const selectSsogLod = <T>(
  items: SsogSelectableItem<T>[],
  options: SsogLodSelectOptions,
): SsogLodSelection<T> => {
  const groups = new Map<number, RankedItem<T>[]>();
  items.forEach((item, index) => {
    const group = groups.get(item.nodeId) ?? [];
    group.push({ item, index, ...getBoundsRank(item, options) });
    groups.set(item.nodeId, group);
  });

  const budget = Math.max(0, Math.floor(options.budget));
  const selectedByNode = new Map<number, NodeSelection<T>>();
  let selectedSplats = 0;

  for (const group of groups.values()) {
    group.sort((a, b) => a.item.lod - b.item.lod || a.index - b.index);
    const coarsestIndex = group.length - 1;
    const coarsest = group[coarsestIndex];
    if (!coarsest) {
      continue;
    }

    selectedByNode.set(coarsest.item.nodeId, { ranked: coarsest, lodIndex: coarsestIndex, lods: group });
    selectedSplats += coarsest.item.count;
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
    const forcedFineUpgrades = Array.from(selectedByNode.values())
      .map((selection) => {
        const finest = selection.lods[0];
        if (!finest || finest === selection.ranked) {
          return undefined;
        }

        const isScreenDominant = finest.screenRadius >= options.lodRangeMax * (options.forceFineScreenRatio ?? 0.9);
        const isStronglyVisible = finest.viewDot >= (options.forceFineViewDot ?? 0.2);
        if (!isScreenDominant || !isStronglyVisible) {
          return undefined;
        }

        return {
          selection,
          finest,
          addedSplats: finest.item.count - selection.ranked.item.count,
          priority: finest.screenRadius * (0.5 + finest.viewDot * 0.5),
        };
      })
      .filter((upgrade): upgrade is NonNullable<typeof upgrade> => !!upgrade && upgrade.addedSplats >= 0)
      .sort((a, b) => b.priority - a.priority || a.addedSplats - b.addedSplats);

    for (const upgrade of forcedFineUpgrades) {
      if (selectedSplats + upgrade.addedSplats > budget) {
        continue;
      }

      upgrade.selection.ranked = upgrade.finest;
      upgrade.selection.lodIndex = 0;
      selectedSplats += upgrade.addedSplats;
    }

    let upgraded = true;
    while (upgraded) {
      upgraded = false;
      const upgrades = Array.from(selectedByNode.values())
        .map((selection) => {
          const nextIndex = selection.lodIndex - 1;
          const next = selection.lods[nextIndex];
          if (!next) {
            return undefined;
          }

          const addedSplats = next.item.count - selection.ranked.item.count;
          const fineDetailBias = 1 + 0.65 / Math.max(1, next.item.lod + 1);
          const closeDetailBias = next.screenRadius > options.lodRangeMax ? 1.8 : 1;
          const viewDetailBias = 0.6 + next.viewDot * 0.4;
          const cost = Math.pow(Math.max(1, addedSplats), 0.55);
          return {
            selection,
            next,
            nextIndex,
            addedSplats,
            score: (next.score * fineDetailBias * closeDetailBias * viewDetailBias) / cost,
          };
        })
        .filter((upgrade): upgrade is NonNullable<typeof upgrade> => !!upgrade && upgrade.addedSplats >= 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.next.item.depth - a.next.item.depth ||
            a.next.item.lod - b.next.item.lod,
        );

      for (const upgrade of upgrades) {
        if (selectedSplats + upgrade.addedSplats > budget) {
          continue;
        }

        upgrade.selection.ranked = upgrade.next;
        upgrade.selection.lodIndex = upgrade.nextIndex;
        selectedSplats += upgrade.addedSplats;
        upgraded = true;
        break;
      }
    }
  } else {
    const rankedCoverage = Array.from(selectedByNode.values())
      .map((selection) => selection.ranked)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.item.depth - a.item.depth ||
          a.item.lod - b.item.lod ||
          a.index - b.index,
      );
    selectedByNode.clear();
    selectedSplats = 0;
    for (const ranked of rankedCoverage) {
      if (selectedSplats > 0 && selectedSplats + ranked.item.count > budget) {
        continue;
      }
      selectedByNode.set(ranked.item.nodeId, { ranked, lodIndex: 0, lods: [ranked] });
      selectedSplats += ranked.item.count;
      if (selectedSplats >= budget) {
        break;
      }
    }
  }

  const selected = Array.from(selectedByNode.values())
    .map((selection) => selection.ranked.item)
    .sort((a, b) => a.nodeId - b.nodeId || a.lod - b.lod);
  const selectedLodValues = new Set(selected.map((item) => item.lod));

  return {
    selected,
    activeChunks: selected.length,
    selectedLods: selectedLodValues.size,
    selectedSplats,
  };
};

export { selectSsogLod };
export type { SsogSelectableItem, SsogLodSelection, SsogLodSelectOptions };
