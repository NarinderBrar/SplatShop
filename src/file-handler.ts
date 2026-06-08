import { MappedReadFileSystem } from "./io";
import { AssetLoader } from "./asset-loader";
import { SplatCloud } from "./splat/SplatCloud";
import type { Scene } from "@babylonjs/core/scene";

type ImportFile = {
  filename: string;
  url?: string;
  contents?: File;
};

type FileHandler = {
  importFiles: (files: ImportFile[], animationFrame?: boolean) => Promise<void>;
};

const allImportExtensions = ".ply,.splat,meta.json,.json,.webp,.sog,.lcc,.bin,.txt,.ksplat,.spz";

const isSog = (filenames: string[]) => {
  const count = (extension: string) =>
    filenames.reduce((sum, f) => sum + (f.endsWith(extension) ? 1 : 0), 0);
  return count("meta.json") === 1 || count(".sog") === 1;
};

const isSsog = (filenames: string[]) => {
  const count = (extension: string) =>
    filenames.reduce((sum, f) => sum + (f.endsWith(extension) ? 1 : 0), 0);
  return count("lod-meta.json") === 1;
};

const isLcc = (filenames: string[]) => {
  const count = (extension: string) =>
    filenames.reduce((sum, f) => sum + (f.endsWith(extension) ? 1 : 0), 0);
  return count(".lcc") === 1;
};

const initFileHandler = (
  dropTarget: HTMLElement,
  scene: Scene,
  assetLoader: AssetLoader,
  status: HTMLElement,
  onLoaded: (splatCloud: SplatCloud) => void,
  onImportStart?: (filename: string) => void,
): FileHandler => {
  let currentSplatCloud: SplatCloud | undefined;

  const showLoadError = (message: string, filename: string) => {
    status.textContent = `${message} while loading '${filename}'`;
  };

  const importSplatModel = async (files: ImportFile[], animationFrame: boolean) => {
    const filenames = files.map((f) => f.filename.toLowerCase());
    let mainIndex: number;

    if (filenames.some((f) => f === "lod-meta.json")) {
      mainIndex = filenames.findIndex((f) => f === "lod-meta.json");
    } else if (filenames.some((f) => f === "meta.json")) {
      mainIndex = filenames.findIndex((f) => f === "meta.json");
    } else if (filenames.some((f) => f.endsWith(".lcc"))) {
      mainIndex = filenames.findIndex((f) => f.endsWith(".lcc"));
    } else {
      mainIndex = 0;
    }

    const mainFile = files[mainIndex];
    const baseUrl = mainFile.url
      ? new URL(".", new URL(mainFile.url, window.location.href)).href
      : undefined;

    const fileSystem = new MappedReadFileSystem(baseUrl);
    files.forEach((f) => {
      if (f.contents) {
        fileSystem.addFile(f.filename, f.contents);
      }
    });

    const filename =
      files.length === 1 && !mainFile.contents && mainFile.url ? mainFile.url : mainFile.filename;

    onImportStart?.(filename);
    const model = await assetLoader.load(filename, fileSystem, animationFrame);
    const nextSplatCloud = new SplatCloud(model.filename, model.asset, scene);
    currentSplatCloud?.dispose();
    currentSplatCloud = nextSplatCloud;
    status.textContent = `${model.filename}: ${model.asset.stats.sourceSplats.toLocaleString()} ${model.asset.kind} splats loaded`;
    onLoaded(currentSplatCloud);
    return model;
  };

  const importFiles = async (files: ImportFile[], animationFrame = false) => {
    try {
      const filenames = files.map((f) => f.filename.toLowerCase());

      if (isSsog(filenames) || isSog(filenames) || isLcc(filenames)) {
        await importSplatModel(files, animationFrame);
        return;
      }

      for (let i = 0; i < filenames.length; i++) {
        const filename = filenames[i].toLowerCase();
        if (
          [".ply", ".splat", ".sog", ".ksplat", ".spz"].every((ext) => !filename.endsWith(ext))
        ) {
          showLoadError("Unrecognized file type", filename);
          return;
        }
      }

      for (let i = 0; i < files.length; i++) {
        const filename = filenames[i].toLowerCase();
        if ([".ply", ".splat", ".sog", ".ksplat", ".spz"].some((ext) => filename.endsWith(ext))) {
          await importSplatModel([files[i]], animationFrame);
        }
      }
    } catch (error) {
      const displayName = files[0]?.filename ?? "unknown";
      showLoadError(error instanceof Error ? error.message : String(error), displayName);
    }
  };

  const fileSelector = document.createElement("input");
  fileSelector.setAttribute("id", "file-selector");
  fileSelector.setAttribute("type", "file");
  fileSelector.setAttribute("accept", allImportExtensions);
  fileSelector.setAttribute("multiple", "true");
  fileSelector.hidden = true;
  fileSelector.onchange = () => {
    if (!fileSelector.files) {
      return;
    }

    const files = Array.from(fileSelector.files).map((file) => ({
      filename: file.name,
      contents: file,
    }));
    void importFiles(files);
    fileSelector.value = "";
  };
  document.body.append(fileSelector);

  status.addEventListener("click", () => fileSelector.click());
  dropTarget.addEventListener("dragover", (event) => {
    event.preventDefault();
    status.textContent = "Drop splat files to import";
  });
  dropTarget.addEventListener("drop", (event) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []).map((file) => ({
      filename: file.name,
      contents: file,
    }));
    void importFiles(files);
  });

  status.textContent = `${status.textContent} Drop splat files here or click this status panel to import.`;

  return {
    importFiles,
  };
};

export { initFileHandler };
export type { FileHandler, ImportFile };
