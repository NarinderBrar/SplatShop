type SplatQualityPreset = "fast" | "balanced" | "full" | "idle" | "screenshot";
type SplatDeviceTier = "low" | "standard" | "high";

type PlatformQualityProfile = {
  preset: SplatQualityPreset;
  deviceTier: SplatDeviceTier;
  renderSplatBudget: number;
  ssogSplatBudget: number;
};

type SplatShaderQualityProfile = {
  minPixelRadius: number;
  maxPixelRadius: number;
  alphaClip: number;
  maxDevicePixelRatio: number;
};

const getPositiveNumberParam = (name: string, fallback: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const getQualityPreset = (): SplatQualityPreset => {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("quality");
  if (
    value === "fast" ||
    value === "balanced" ||
    value === "full" ||
    value === "idle" ||
    value === "screenshot"
  ) {
    return value;
  }
  return params.get("ssogReference") === "true" ? "full" : "balanced";
};

const getDeviceTier = (): SplatDeviceTier => {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("deviceTier") ?? params.get("ssogDeviceTier");
  if (explicit === "low" || explicit === "standard" || explicit === "high") {
    return explicit;
  }

  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } };
  const memoryGb = nav.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;
  const isMobile =
    nav.userAgentData?.mobile ??
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

  if (isMobile || memoryGb <= 4 || cores <= 4) {
    return "low";
  }
  if (memoryGb >= 12 && cores >= 8) {
    return "high";
  }
  return "standard";
};

const getPlatformQualityProfile = (): PlatformQualityProfile => {
  const preset = getQualityPreset();
  const deviceTier = getDeviceTier();
  const budgets: Record<SplatDeviceTier, Record<SplatQualityPreset, number>> = {
    low: {
      fast: 750_000,
      balanced: 1_200_000,
      full: 2_000_000,
      idle: 2_500_000,
      screenshot: 3_000_000,
    },
    standard: {
      fast: 1_500_000,
      balanced: 2_500_000,
      full: 4_000_000,
      idle: 5_000_000,
      screenshot: 6_000_000,
    },
    high: {
      fast: 2_000_000,
      balanced: 3_000_000,
      full: 6_000_000,
      idle: 8_000_000,
      screenshot: 10_000_000,
    },
  };
  const budget = budgets[deviceTier][preset];
  return {
    preset,
    deviceTier,
    renderSplatBudget: budget,
    ssogSplatBudget: budget,
  };
};

const getSplatShaderQualityProfile = (): SplatShaderQualityProfile => {
  const preset = getQualityPreset();
  const deviceTier = getDeviceTier();
  const base: Record<SplatQualityPreset, SplatShaderQualityProfile> = {
    fast: {
      minPixelRadius: 2.5,
      maxPixelRadius: 56,
      alphaClip: 1.5 / 255,
      maxDevicePixelRatio: 1.15,
    },
    balanced: {
      minPixelRadius: 2,
      maxPixelRadius: 96,
      alphaClip: 1 / 255,
      maxDevicePixelRatio: 1.5,
    },
    full: {
      minPixelRadius: 1.5,
      maxPixelRadius: 128,
      alphaClip: 0.75 / 255,
      maxDevicePixelRatio: 2,
    },
    idle: {
      minPixelRadius: 1.25,
      maxPixelRadius: 144,
      alphaClip: 0.5 / 255,
      maxDevicePixelRatio: 2,
    },
    screenshot: {
      minPixelRadius: 1,
      maxPixelRadius: 192,
      alphaClip: 0.25 / 255,
      maxDevicePixelRatio: 2.5,
    },
  };
  const tierScale =
    deviceTier === "low"
      ? { min: 1.15, max: 0.75, dpr: 0.85, alpha: 1.25 }
      : deviceTier === "high"
        ? { min: 0.9, max: 1.2, dpr: 1.15, alpha: 0.85 }
        : { min: 1, max: 1, dpr: 1, alpha: 1 };
  const selected = base[preset];
  return {
    minPixelRadius: getPositiveNumberParam("splatMinPixelRadius", selected.minPixelRadius * tierScale.min),
    maxPixelRadius: getPositiveNumberParam("splatMaxPixelRadius", selected.maxPixelRadius * tierScale.max),
    alphaClip: getPositiveNumberParam("splatAlphaClip", selected.alphaClip * tierScale.alpha),
    maxDevicePixelRatio: getPositiveNumberParam(
      "maxDevicePixelRatio",
      Math.max(1, selected.maxDevicePixelRatio * tierScale.dpr),
    ),
  };
};

const getExplicitSplatBudget = (): number | undefined => {
  const explicitBudget = Number(new URLSearchParams(window.location.search).get("splatBudget"));
  return Number.isFinite(explicitBudget) && explicitBudget > 0 ? Math.floor(explicitBudget) : undefined;
};

const getQualitySplatBudget = (sourceSplats: number, options: { referenceParam?: string } = {}): number => {
  const params = new URLSearchParams(window.location.search);
  const explicitBudget = getExplicitSplatBudget();
  if (explicitBudget !== undefined) {
    return Math.min(sourceSplats, explicitBudget);
  }
  if (options.referenceParam && params.get(options.referenceParam) === "true") {
    return sourceSplats;
  }
  return Math.min(sourceSplats, getPlatformQualityProfile().renderSplatBudget);
};

export {
  getDeviceTier,
  getExplicitSplatBudget,
  getPlatformQualityProfile,
  getQualityPreset,
  getQualitySplatBudget,
  getSplatShaderQualityProfile,
};
export type { PlatformQualityProfile, SplatDeviceTier, SplatQualityPreset, SplatShaderQualityProfile };
