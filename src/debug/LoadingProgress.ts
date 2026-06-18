import type { SplatCloud } from "../splat/SplatCloud";

type StreamingProgressStats = {
  renderSplats: number;
  selectedSplats?: number;
  requestedSplats?: number;
  pendingChunks?: number;
  pendingUploadChunks?: number;
  queuedChunks?: number;
};

class LoadingProgress {
  private readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly detail: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private visible = false;
  private lastProgress = 0;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "loading-progress";
    this.root.innerHTML = [
      '<div class="loading-progress__header">',
      '  <div class="loading-progress__title"></div>',
      '  <div class="loading-progress__detail"></div>',
      "</div>",
      '<div class="loading-progress__track">',
      '  <div class="loading-progress__fill"></div>',
      "</div>",
    ].join("");
    document.body.appendChild(this.root);

    this.title = this.root.querySelector(".loading-progress__title") as HTMLDivElement;
    this.detail = this.root.querySelector(".loading-progress__detail") as HTMLDivElement;
    this.fill = this.root.querySelector(".loading-progress__fill") as HTMLDivElement;
  }

  start(label: string): void {
    this.lastProgress = 0;
    this.title.textContent = label;
    this.detail.textContent = "Preparing splat data";
    this.fill.style.width = "42%";
    this.root.classList.add("is-visible", "is-indeterminate");
    this.visible = true;
  }

  setCloud(splatCloud: SplatCloud): void {
    const stats = splatCloud.renderPass.getStats() as StreamingProgressStats;
    const targetSplats = Math.max(0, stats.selectedSplats ?? stats.requestedSplats ?? splatCloud.bufferStats.numSplats);
    if (targetSplats <= 0) {
      this.start(`Loading ${splatCloud.filename}`);
      return;
    }

    this.root.classList.remove("is-indeterminate");
    this.updateProgress(splatCloud, stats, targetSplats);
  }

  update(splatCloud?: SplatCloud): void {
    if (!splatCloud || !this.visible) {
      return;
    }

    const stats = splatCloud.renderPass.getStats() as StreamingProgressStats;
    const targetSplats = Math.max(0, stats.selectedSplats ?? stats.requestedSplats ?? splatCloud.bufferStats.numSplats);
    if (targetSplats <= 0) {
      return;
    }

    this.updateProgress(splatCloud, stats, targetSplats);
  }

  private updateProgress(splatCloud: SplatCloud, stats: StreamingProgressStats, targetSplats: number): void {
    const rawProgress = Math.min(1, stats.renderSplats / Math.max(1, targetSplats));
    const progress = rawProgress >= 0.995 ? 1 : Math.max(this.lastProgress, rawProgress);
    this.lastProgress = progress;

    const pendingChunks = stats.pendingChunks ?? 0;
    const pendingUploadChunks = stats.pendingUploadChunks ?? 0;
    const queuedChunks = stats.queuedChunks ?? 0;
    const waitingChunks = pendingChunks + pendingUploadChunks + queuedChunks;
    const percent = Math.round(progress * 100);
    this.title.textContent = `Loading ${splatCloud.filename}`;
    this.detail.textContent =
      progress >= 1 && waitingChunks === 0
        ? "Splats ready"
        : `${percent}% splats ready`;
    this.fill.style.width = `${Math.max(2, percent)}%`;
    this.root.classList.add("is-visible");

    if (progress >= 1 && waitingChunks === 0) {
      window.setTimeout(() => this.hide(), 450);
    }
  }

  private hide(): void {
    this.visible = false;
    this.root.classList.remove("is-visible", "is-indeterminate");
  }
}

export { LoadingProgress };
