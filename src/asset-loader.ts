import type { ReadFileSystem } from "@playcanvas/splat-transform";

import { loadSplatData, validateSplatData } from "./io";

class AssetLoader {
  async load(filename: string, fileSystem: ReadFileSystem, animationFrame?: boolean, skipReorder?: boolean) {
    void animationFrame;
    const { splatData, transform, asset } = await loadSplatData(
      filename,
      fileSystem,
      skipReorder,
    );
    if (splatData) {
      validateSplatData(splatData);
    }

    return {
      filename,
      splatData,
      transform,
      asset,
    };
  }
}

export { AssetLoader };
