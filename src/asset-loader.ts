import type { ReadFileSystem } from "@playcanvas/splat-transform";

import { loadSplatData, validateSplatData } from "./io";

type AssetLoadProgress = {
  stage: "read" | "decode";
  filename: string;
  bytesLoaded?: number;
  totalBytes?: number;
};

class AssetLoader {
  async load(
    filename: string,
    fileSystem: ReadFileSystem,
    animationFrame?: boolean,
    skipReorder?: boolean,
    onProgress?: (progress: AssetLoadProgress) => void,
  ) {
    void animationFrame;
    onProgress?.({ stage: "decode", filename });
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
export type { AssetLoadProgress };
