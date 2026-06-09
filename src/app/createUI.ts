import type { ViewerDebugStats } from "../debug/ViewerDebugStats";

const VIZ_MODES: Array<{ mode: number; label: string; svg: string }> = [
  {
    mode: 0,
    label: "Normal",
    svg: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="currentColor" stroke="none"/></svg>`,
  },
  {
    mode: 1,
    label: "Center",
    svg: `<svg viewBox="0 0 16 16"><circle cx="5" cy="8" r="2.2" fill="currentColor" stroke="none"/><circle cx="11" cy="6" r="1.6" fill="currentColor" stroke="none"/><circle cx="10" cy="11" r="1.8" fill="currentColor" stroke="none"/></svg>`,
  },
  {
    mode: 2,
    label: "Chunk color",
    svg: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor"/><path d="M5 6h6M5 8h6M5 10h6" stroke="currentColor" stroke-width="1.2"/></svg>`,
  },
];

export function createUI(
  debugStats: ViewerDebugStats,
  onVizModeChange: (mode: number) => void,
): void {
  const vizBar = document.createElement("div");
  vizBar.className = "viz-bar";
  for (const viz of VIZ_MODES) {
    const btn = document.createElement("button");
    btn.className = "viz-button" + (viz.mode === 0 ? " is-active" : "");
    btn.title = viz.label;
    btn.setAttribute("aria-label", viz.label);
    btn.innerHTML = viz.svg;
    btn.addEventListener("click", () => {
      onVizModeChange(viz.mode);
      for (const child of vizBar.children) {
        (child as HTMLElement).classList.toggle("is-active", child === btn);
      }
    });
    vizBar.append(btn);
  }
  document.body.append(vizBar);

  const debugBtn = document.createElement("button");
  debugBtn.className = "debug-toggle";
  debugBtn.textContent = "⚙";
  debugBtn.addEventListener("click", () => {
    const isActive = debugBtn.classList.toggle("is-active");
    debugStats.setVisible(isActive);
  });
  document.body.append(debugBtn);
}
