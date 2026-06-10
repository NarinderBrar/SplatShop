export type ToolId = "pointSelect" | "circleSelect" | "marqueeSelect" | "lassoSelect" | "move" | "rotate" | "paintBrush";

export type SelectionMode = "normal" | "add" | "sub";

export interface ToolCallbacks {
  onToolSelect?: (tool: ToolId) => void;
  onSelectionModeChange?: (mode: SelectionMode) => void;
  onThresholdChange?: (value: number) => void;
  onBehindToggle?: (value: boolean) => void;
  onMoveChange?: (axis: "x" | "y" | "z", value: number) => void;
  onRotateChange?: (axis: "x" | "y" | "z", value: number) => void;
  onPaintColorChange?: (color: string) => void;
  onPaintMixChange?: (value: number) => void;
  onPaintRadiusChange?: (value: number) => void;
  onPropertyTabChange?: (tab: "properties" | "debug") => void;
  onHsvChange?: (component: "hue" | "saturation" | "value", value: number) => void;
  onRgbChange?: (component: "r" | "g" | "b", value: number) => void;
  onHideSelected?: () => void;
  onCopySelected?: () => void;
  onVizModeChange?: (mode: number) => void;
}

const VIZ_MODES: Array<{ mode: number; label: string; svg: string }> = [
  {
    mode: 0,
    label: "Normal",
    svg: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="currentColor" stroke="none"/></svg>`,
  },
  {
    mode: 1,
    label: "Particle cloud",
    svg: `<svg viewBox="0 0 16 16"><circle cx="5" cy="8" r="2.2" fill="currentColor" stroke="none"/><circle cx="11" cy="6" r="1.6" fill="currentColor" stroke="none"/><circle cx="10" cy="11" r="1.8" fill="currentColor" stroke="none"/></svg>`,
  },
  {
    mode: 2,
    label: "Chunk color",
    svg: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor"/><path d="M5 6h6M5 8h6M5 10h6" stroke="currentColor" stroke-width="1.2"/></svg>`,
  },
  {
    mode: 3,
    label: "Color group",
    svg: `<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="5" height="5" rx="1" fill="currentColor" stroke="none"/><rect x="8.5" y="2.5" width="5" height="5" rx="1" fill="currentColor" stroke="none" opacity="0.6"/><rect x="2.5" y="8.5" width="5" height="5" rx="1" fill="currentColor" stroke="none" opacity="0.4"/><rect x="8.5" y="8.5" width="5" height="5" rx="1" fill="currentColor" stroke="none" opacity="0.8"/></svg>`,
  },
];

interface ToolDef {
  id: ToolId;
  label: string;
  svg: string;
}

const TOOLS: ToolDef[] = [
  { id: "pointSelect", label: "Point select", svg: pointSelectIconSvg() },
  { id: "circleSelect", label: "Circle select", svg: circleIconSvg() },
  { id: "marqueeSelect", label: "Marquee select", svg: marqueeIconSvg() },
  { id: "lassoSelect", label: "Lasso select", svg: lassoIconSvg() },
  { id: "move", label: "Move", svg: moveIconSvg() },
  { id: "rotate", label: "Rotate", svg: rotateIconSvg() },
  { id: "paintBrush", label: "Paint brush", svg: paintBrushIconSvg() },
];

const SELECTION_TOOLS: ToolId[] = ["pointSelect", "circleSelect", "marqueeSelect", "lassoSelect"];
const isSelectionTool = (t: ToolId) => SELECTION_TOOLS.includes(t);

export function createUI(callbacks?: ToolCallbacks, statsElement?: HTMLElement): void {
  let activeTool: ToolId = "pointSelect";

  const toolbar = document.createElement("div");
  toolbar.className = "tool-rail";

  const toolButtons = new Map<ToolId, HTMLButtonElement>();

  for (let i = 0; i < TOOLS.length; i++) {
    const tool = TOOLS[i];
    if (i === 4) {
      const sep = document.createElement("div");
      sep.className = "tool-separator";
      toolbar.append(sep);
    }

    const btn = document.createElement("button");
    btn.className = "tool-mode-button" + (tool.id === activeTool ? " is-active" : "");
    btn.title = tool.label;
    btn.setAttribute("aria-label", tool.label);
    btn.innerHTML = tool.svg;
    btn.addEventListener("click", () => setActiveTool(tool.id));
    toolButtons.set(tool.id, btn);
    toolbar.append(btn);
  }

  document.body.append(toolbar);

  const optionsBar = document.createElement("div");
  optionsBar.className = "tool-options-bar";
  document.body.append(optionsBar);

  const selectionOptions = createSelectionOptions(callbacks);
  const moveOptions = createMoveOptions(callbacks);
  const rotateOptions = createRotateOptions(callbacks);
  const paintOptions = createPaintOptions(callbacks);

  optionsBar.append(selectionOptions, moveOptions, rotateOptions, paintOptions);

  const propertiesPanel = createPropertiesPanel(callbacks, statsElement);
  document.body.append(propertiesPanel);

  const vizBar = document.createElement("div");
  vizBar.className = "viz-bar";
  let activeVizMode = 0;
  for (const viz of VIZ_MODES) {
    const btn = document.createElement("button");
    btn.className = "viz-button" + (viz.mode === activeVizMode ? " is-active" : "");
    btn.title = viz.label;
    btn.setAttribute("aria-label", viz.label);
    btn.innerHTML = viz.svg;
    btn.addEventListener("click", () => {
      activeVizMode = viz.mode;
      callbacks?.onVizModeChange?.(viz.mode);
      for (const child of vizBar.children) {
        (child as HTMLElement).classList.toggle("is-active", child === btn);
      }
    });
    vizBar.append(btn);
  }
  document.body.append(vizBar);

  function setActiveTool(tool: ToolId): void {
    activeTool = tool;
    callbacks?.onToolSelect?.(tool);
    for (const [id, btn] of toolButtons) {
      btn.classList.toggle("is-active", id === tool);
    }

    const isSel = isSelectionTool(tool);
    selectionOptions.classList.toggle("is-visible", isSel);
    moveOptions.classList.toggle("is-visible", tool === "move");
    rotateOptions.classList.toggle("is-visible", tool === "rotate");
    paintOptions.classList.toggle("is-visible", tool === "paintBrush");
  }

  setActiveTool(activeTool);
}

function createSelectionOptions(callbacks?: ToolCallbacks): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "tool-settings";

  let activeMode: SelectionMode = "normal";

  const modeGroup = document.createElement("div");
  modeGroup.className = "selection-mode-control";
  const modes: Array<{ id: SelectionMode; label: string }> = [
    { id: "normal", label: "Normal" },
    { id: "add", label: "Add" },
    { id: "sub", label: "Sub" },
  ];
  for (const m of modes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = m.label;
    btn.classList.toggle("is-active", m.id === activeMode);
    btn.addEventListener("click", () => {
      activeMode = m.id;
      callbacks?.onSelectionModeChange?.(m.id);
      for (const child of modeGroup.querySelectorAll("button")) {
        child.classList.toggle("is-active", child === btn);
      }
    });
    modeGroup.append(btn);
  }
  container.append(modeGroup);

  const thresholdField = document.createElement("label");
  thresholdField.className = "selection-control";
  thresholdField.textContent = "Threshold";
  const thresholdInput = document.createElement("input");
  thresholdInput.type = "range";
  thresholdInput.className = "tool-range";
  thresholdInput.min = "0.01";
  thresholdInput.max = "1";
  thresholdInput.step = "0.01";
  thresholdInput.value = "0.14";
  thresholdInput.addEventListener("input", () => {
    callbacks?.onThresholdChange?.(thresholdInput.valueAsNumber);
  });
  thresholdField.append(thresholdInput);
  container.append(thresholdField);

  const behindField = document.createElement("label");
  behindField.className = "selection-control";
  const behindCheck = document.createElement("input");
  behindCheck.type = "checkbox";
  behindCheck.checked = true;
  behindCheck.addEventListener("change", () => {
    callbacks?.onBehindToggle?.(behindCheck.checked);
  });
  behindField.append(behindCheck, " Behind");
  container.append(behindField);

  return container;
}

function createMoveOptions(callbacks?: ToolCallbacks): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "tool-settings";

  const group = document.createElement("div");
  group.className = "coord-input-group";

  for (const axis of ["x", "y", "z"] as const) {
    const label = document.createElement("label");
    label.textContent = axis.toUpperCase();
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.01";
    input.value = "0";
    input.addEventListener("input", () => {
      callbacks?.onMoveChange?.(axis, input.valueAsNumber || 0);
    });
    label.append(input);
    group.append(label);
  }

  container.append(group);
  return container;
}

function createRotateOptions(callbacks?: ToolCallbacks): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "tool-settings";

  const group = document.createElement("div");
  group.className = "coord-input-group";

  for (const axis of ["x", "y", "z"] as const) {
    const label = document.createElement("label");
    label.textContent = axis.toUpperCase();
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.1";
    input.value = "0";
    input.addEventListener("input", () => {
      callbacks?.onRotateChange?.(axis, input.valueAsNumber || 0);
    });
    label.append(input);
    group.append(label);
  }

  container.append(group);
  return container;
}

function createPaintOptions(callbacks?: ToolCallbacks): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "tool-settings";

  const colorField = document.createElement("label");
  colorField.className = "selection-control";
  colorField.textContent = "Color";
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = "#d92626";
  colorInput.addEventListener("input", () => {
    callbacks?.onPaintColorChange?.(colorInput.value);
  });
  colorField.append(colorInput);
  container.append(colorField);

  const mixField = document.createElement("label");
  mixField.className = "selection-control";
  mixField.textContent = "Mix";
  const mixInput = document.createElement("input");
  mixInput.type = "range";
  mixInput.className = "tool-range";
  mixInput.min = "0";
  mixInput.max = "100";
  mixInput.value = "35";
  mixInput.addEventListener("input", () => {
    callbacks?.onPaintMixChange?.(mixInput.valueAsNumber);
  });
  mixField.append(mixInput);
  container.append(mixField);

  const radiusField = document.createElement("label");
  radiusField.className = "selection-control";
  radiusField.textContent = "Radius";
  const radiusInput = document.createElement("input");
  radiusInput.type = "range";
  radiusInput.className = "tool-range";
  radiusInput.min = "1";
  radiusInput.max = "128";
  radiusInput.value = "18";
  radiusInput.addEventListener("input", () => {
    callbacks?.onPaintRadiusChange?.(radiusInput.valueAsNumber);
  });
  radiusField.append(radiusInput);
  container.append(radiusField);

  return container;
}

function createPropertiesPanel(callbacks?: ToolCallbacks, statsElement?: HTMLElement): HTMLDivElement {
  const panel = document.createElement("div");
  panel.className = "properties-panel";

  const tabs = document.createElement("div");
  tabs.className = "properties-tabs";

  const propertiesTab = document.createElement("button");
  propertiesTab.className = "properties-tab is-active";
  propertiesTab.textContent = "Properties";
  propertiesTab.addEventListener("click", () => setTab("properties"));

  const debugTab = document.createElement("button");
  debugTab.className = "properties-tab";
  debugTab.textContent = "Debug";
  debugTab.addEventListener("click", () => setTab("debug"));

  tabs.append(propertiesTab, debugTab);
  panel.append(tabs);

  const propertiesContent = document.createElement("div");
  propertiesContent.className = "properties-content is-visible";

  const hsvSection = document.createElement("div");
  hsvSection.className = "properties-section";
  hsvSection.append(
    createSliderRow("H", 0, -180, 180, 1, (v) => callbacks?.onHsvChange?.("hue", v)),
    createSliderRow("S", 100, 0, 200, 1, (v) => callbacks?.onHsvChange?.("saturation", v)),
    createSliderRow("V", 100, 0, 200, 1, (v) => callbacks?.onHsvChange?.("value", v)),
  );
  propertiesContent.append(hsvSection);

  const rgbSection = document.createElement("div");
  rgbSection.className = "properties-section";
  rgbSection.append(
    createSliderRow("R", 255, 0, 255, 1, (v) => callbacks?.onRgbChange?.("r", v)),
    createSliderRow("G", 255, 0, 255, 1, (v) => callbacks?.onRgbChange?.("g", v)),
    createSliderRow("B", 255, 0, 255, 1, (v) => callbacks?.onRgbChange?.("b", v)),
  );
  propertiesContent.append(rgbSection);

  const actionsSection = document.createElement("div");
  actionsSection.className = "properties-section";
  const actionsRow = document.createElement("div");
  actionsRow.className = "properties-actions";

  const hideBtn = document.createElement("button");
  hideBtn.className = "properties-action-button is-danger";
  hideBtn.textContent = "Hide";
  hideBtn.addEventListener("click", () => callbacks?.onHideSelected?.());

  const copyBtn = document.createElement("button");
  copyBtn.className = "properties-action-button";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => callbacks?.onCopySelected?.());

  actionsRow.append(hideBtn, copyBtn);
  actionsSection.append(actionsRow);
  propertiesContent.append(actionsSection);

  panel.append(propertiesContent);

  const debugContent = document.createElement("div");
  debugContent.className = "properties-content";
  debugContent.id = "debug-content-panel";
  if (statsElement) {
    debugContent.append(statsElement);
  }
  panel.append(debugContent);

  function setTab(tab: "properties" | "debug"): void {
    callbacks?.onPropertyTabChange?.(tab);
    propertiesTab.classList.toggle("is-active", tab === "properties");
    debugTab.classList.toggle("is-active", tab === "debug");
    propertiesContent.classList.toggle("is-visible", tab === "properties");
    debugContent.classList.toggle("is-visible", tab === "debug");
  }

  return panel;
}

function createSliderRow(
  label: string,
  initial: number,
  min: number,
  max: number,
  step: number,
  onChange: (value: number) => void,
): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "properties-row";

  const lbl = document.createElement("label");
  lbl.textContent = label;

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(initial);

  const value = document.createElement("span");
  value.className = "properties-value";
  value.textContent = String(initial);

  slider.addEventListener("input", () => {
    const v = slider.valueAsNumber;
    value.textContent = String(Math.round(v));
    onChange(v);
  });

  row.append(lbl, slider, value);
  return row;
}

function pointSelectIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 3 6.8 16.4 2.1-6.1 6.1-2.1L5 3Z" />
      <path d="m14 14 4.8 4.8" />
    </svg>
  `;
}

function circleIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 5v14M5 12h14" />
    </svg>
  `;
}

function marqueeIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 5h14v14H5z" />
      <path d="M8 5v14M16 5v14M5 8h14M5 16h14" />
    </svg>
  `;
}

function lassoIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 13c-1.2-4.4 3-8.4 8-7.3 5.1 1.1 8 5.2 5.7 8.5-2.2 3.1-8.4 2.8-10.3 1.2" />
      <path d="M8.4 15.4 5.5 21" />
    </svg>
  `;
}

function moveIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v18M3 12h18" />
      <path d="m12 3-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />
    </svg>
  `;
}

function rotateIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12a8 8 0 0 1 13.7-5.6" />
      <path d="M18 3v5h-5" />
      <path d="M20 12a8 8 0 0 1-13.7 5.6" />
      <path d="M6 21v-5h5" />
    </svg>
  `;
}

function paintBrushIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 4 5 14" />
      <path d="m14 5 5 5" />
      <path d="M4 15c3 0 5 2 5 5-2.7 0-5-2.2-5-5Z" />
      <path d="M12 7 17 2l5 5-5 5" />
    </svg>
  `;
}
