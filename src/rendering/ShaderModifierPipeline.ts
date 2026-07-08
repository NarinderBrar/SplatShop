import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";

type ShaderModifierLanguage = "wgsl" | "glsl";

type SplatShaderModifierConfig = {
  clipPlane?: [number, number, number, number];
  colorTint?: [number, number, number, number];
  alphaScale: number;
  reveal: number;
  invertColor: boolean;
};

type SplatShaderVariantInput = {
  language: ShaderModifierLanguage;
  vertexSource: string;
  fragmentSource: string;
  config?: SplatShaderModifierConfig;
};

type SplatShaderVariant = {
  key: string;
  vertexSource: string;
  fragmentSource: string;
  uniformNames: string[];
  config: SplatShaderModifierConfig;
};

const CUSTOM_VERTEX_DEFINITIONS = "#define CUSTOM_VERTEX_DEFINITIONS";
const CUSTOM_VERTEX_CENTER_FILTER = "#define CUSTOM_VERTEX_CENTER_FILTER";
const CUSTOM_FRAGMENT_DEFINITIONS = "#define CUSTOM_FRAGMENT_DEFINITIONS";
const CUSTOM_FRAGMENT_COLOR_MODIFIERS = "#define CUSTOM_FRAGMENT_COLOR_MODIFIERS";
const variantCache = new Map<string, SplatShaderVariant>();

const defaultConfig: SplatShaderModifierConfig = {
  alphaScale: 1,
  reveal: 1,
  invertColor: false,
};

const parseNumberList = (value: string | null, count: number): number[] | undefined => {
  if (!value) {
    return undefined;
  }
  const values = value.split(",").map((part) => Number(part.trim()));
  if (values.length !== count || values.some((item) => !Number.isFinite(item))) {
    return undefined;
  }
  return values;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const getSearchParams = (): URLSearchParams => {
  if (typeof window === "undefined") {
    return new URLSearchParams();
  }
  return new URLSearchParams(window.location.search);
};

const getSplatShaderModifierConfig = (): SplatShaderModifierConfig => {
  const params = getSearchParams();
  const clipPlane = parseNumberList(params.get("shaderClipPlane"), 4);
  const colorTint = parseNumberList(params.get("shaderTint"), 4);
  const alphaScale = Number(params.get("shaderAlphaScale"));
  const reveal = Number(params.get("shaderReveal"));
  return {
    clipPlane: clipPlane as [number, number, number, number] | undefined,
    colorTint: colorTint as [number, number, number, number] | undefined,
    alphaScale: Number.isFinite(alphaScale) && alphaScale >= 0 ? alphaScale : defaultConfig.alphaScale,
    reveal: Number.isFinite(reveal) ? clamp01(reveal) : defaultConfig.reveal,
    invertColor: params.get("shaderInvert") === "true",
  };
};

const getModifierKey = (config: SplatShaderModifierConfig): string => [
  config.clipPlane ? `clip:${config.clipPlane.map((value) => value.toFixed(6)).join(",")}` : "clip:none",
  config.colorTint ? `tint:${config.colorTint.map((value) => value.toFixed(6)).join(",")}` : "tint:none",
  `alpha:${config.alphaScale.toFixed(6)}`,
  `reveal:${config.reveal.toFixed(6)}`,
  `invert:${config.invertColor ? 1 : 0}`,
].join("|");

const hashSource = (source: string): string => {
  let hash = 5381;
  for (let i = 0; i < source.length; i++) {
    hash = ((hash << 5) + hash) ^ source.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
};

const hasFragmentModifiers = (config: SplatShaderModifierConfig): boolean =>
  Boolean(config.colorTint) ||
  config.alphaScale !== 1 ||
  config.reveal < 1 ||
  config.invertColor;

const buildWgslVertexDefinitions = (config: SplatShaderModifierConfig): string =>
  config.clipPlane ? "uniform modifierClipPlane: vec4f;" : "";

const buildGlslVertexDefinitions = (config: SplatShaderModifierConfig): string =>
  config.clipPlane ? "uniform vec4 modifierClipPlane;" : "";

const buildWgslCenterFilter = (config: SplatShaderModifierConfig): string =>
  config.clipPlane
    ? [
        "  if (dot(center, uniforms.modifierClipPlane.xyz) + uniforms.modifierClipPlane.w < 0.0) {",
        "    vertexOutputs.position = vec4f(0.0, 0.0, 2.0, 1.0);",
        "    vertexOutputs.vCorner = vec2f(2.0, 2.0);",
        "    vertexOutputs.vColor = vec4f(0.0);",
        "    return vertexOutputs;",
        "  }",
      ].join("\n")
    : "";

const buildGlslCenterFilter = (config: SplatShaderModifierConfig): string =>
  config.clipPlane
    ? [
        "  if (dot(position, modifierClipPlane.xyz) + modifierClipPlane.w < 0.0) {",
        "    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);",
        "    vCorner = vec2(2.0);",
        "    vColor = vec4(0.0);",
        "    return;",
        "  }",
      ].join("\n")
    : "";

const buildWgslFragmentDefinitions = (config: SplatShaderModifierConfig): string => {
  if (!hasFragmentModifiers(config)) {
    return "";
  }
  const uniforms = [
    config.colorTint ? "uniform modifierColorTint: vec4f;" : "",
    config.alphaScale !== 1 ? "uniform modifierAlphaScale: f32;" : "",
    config.reveal < 1 ? "uniform modifierReveal: f32;" : "",
  ].filter(Boolean);
  return uniforms.join("\n");
};

const buildGlslFragmentDefinitions = (config: SplatShaderModifierConfig): string => {
  if (!hasFragmentModifiers(config)) {
    return "";
  }
  const uniforms = [
    config.colorTint ? "uniform vec4 modifierColorTint;" : "",
    config.alphaScale !== 1 ? "uniform float modifierAlphaScale;" : "",
    config.reveal < 1 ? "uniform float modifierReveal;" : "",
  ].filter(Boolean);
  return uniforms.join("\n");
};

const buildWgslColorModifiers = (config: SplatShaderModifierConfig): string => {
  const lines: string[] = [];
  if (config.reveal < 1) {
    lines.push(
      "  let modifierRevealHash = fract(sin(dot(input.vColor.rgb, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);",
      "  if (modifierRevealHash > uniforms.modifierReveal) {",
      "    discard;",
      "  }",
    );
  }
  if (config.alphaScale !== 1) {
    lines.push("  outputColor *= uniforms.modifierAlphaScale;");
  }
  if (config.colorTint) {
    lines.push("  outputColor.rgb = mix(outputColor.rgb, outputColor.rgb * uniforms.modifierColorTint.rgb, clamp(uniforms.modifierColorTint.a, 0.0, 1.0));");
  }
  if (config.invertColor) {
    lines.push("  outputColor.rgb = vec3f(outputColor.a) - outputColor.rgb;");
  }
  return lines.join("\n");
};

const buildGlslColorModifiers = (config: SplatShaderModifierConfig): string => {
  const lines: string[] = [];
  if (config.reveal < 1) {
    lines.push(
      "  float modifierRevealHash = fract(sin(dot(vColor.rgb, vec3(12.9898, 78.233, 37.719))) * 43758.5453);",
      "  if (modifierRevealHash > modifierReveal) {",
      "    discard;",
      "  }",
    );
  }
  if (config.alphaScale !== 1) {
    lines.push("  outputColor *= modifierAlphaScale;");
  }
  if (config.colorTint) {
    lines.push("  outputColor.rgb = mix(outputColor.rgb, outputColor.rgb * modifierColorTint.rgb, clamp(modifierColorTint.a, 0.0, 1.0));");
  }
  if (config.invertColor) {
    lines.push("  outputColor.rgb = vec3(outputColor.a) - outputColor.rgb;");
  }
  return lines.join("\n");
};

const replaceMarker = (source: string, marker: string, replacement: string): string =>
  source.replaceAll(marker, replacement);

const buildSplatShaderVariant = ({
  language,
  vertexSource,
  fragmentSource,
  config = getSplatShaderModifierConfig(),
}: SplatShaderVariantInput): SplatShaderVariant => {
  const key = `${language}|${getModifierKey(config)}|${hashSource(vertexSource)}:${hashSource(fragmentSource)}`;
  const cached = variantCache.get(key);
  if (cached) {
    return cached;
  }

  const vertexDefinitions = language === "wgsl"
    ? buildWgslVertexDefinitions(config)
    : buildGlslVertexDefinitions(config);
  const centerFilter = language === "wgsl"
    ? buildWgslCenterFilter(config)
    : buildGlslCenterFilter(config);
  const fragmentDefinitions = language === "wgsl"
    ? buildWgslFragmentDefinitions(config)
    : buildGlslFragmentDefinitions(config);
  const colorModifiers = language === "wgsl"
    ? buildWgslColorModifiers(config)
    : buildGlslColorModifiers(config);

  const uniformNames = [
    config.clipPlane ? "modifierClipPlane" : "",
    config.colorTint ? "modifierColorTint" : "",
    config.alphaScale !== 1 ? "modifierAlphaScale" : "",
    config.reveal < 1 ? "modifierReveal" : "",
  ].filter(Boolean);

  const variant = {
    key,
    vertexSource: replaceMarker(
      replaceMarker(vertexSource, CUSTOM_VERTEX_DEFINITIONS, vertexDefinitions),
      CUSTOM_VERTEX_CENTER_FILTER,
      centerFilter,
    ),
    fragmentSource: replaceMarker(
      replaceMarker(fragmentSource, CUSTOM_FRAGMENT_DEFINITIONS, fragmentDefinitions),
      CUSTOM_FRAGMENT_COLOR_MODIFIERS,
      colorModifiers,
    ),
    uniformNames,
    config,
  };
  variantCache.set(key, variant);
  return variant;
};

const applySplatShaderModifierUniforms = (
  material: ShaderMaterial,
  variant: SplatShaderVariant,
): void => {
  const { config } = variant;
  if (config.clipPlane) {
    material.setArray4("modifierClipPlane", config.clipPlane);
  }
  if (config.colorTint) {
    material.setArray4("modifierColorTint", config.colorTint);
  }
  if (config.alphaScale !== 1) {
    material.setFloat("modifierAlphaScale", config.alphaScale);
  }
  if (config.reveal < 1) {
    material.setFloat("modifierReveal", config.reveal);
  }
};

export {
  applySplatShaderModifierUniforms,
  buildSplatShaderVariant,
  getSplatShaderModifierConfig,
};
export type { SplatShaderModifierConfig, SplatShaderVariant };
