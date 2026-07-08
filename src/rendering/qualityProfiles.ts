type SplatQualityPreset = "fast" | "balanced" | "full" | "idle" | "screenshot";
type SplatDeviceTier = "low" | "standard" | "high";
type SplatPlatformKind = "desktop" | "mobile" | "ios" | "android" | "quest" | "vision";

type PlatformQualityProfile = {
  preset: SplatQualityPreset;
  platform: SplatPlatformKind;
  deviceTier: SplatDeviceTier;
  renderSplatBudget: number;
  ssogSplatBudget: number;
};

type SplatShaderQualityProfile = {
  minAlpha: number;
  minPixelRadius: number;
  maxPixelRadius: number;
  maxStdDev: number;
  clipXY: number;
  blurAmount: number;
  preBlurAmount: number;
  alphaClip: number;
  maxDevicePixelRatio: number;
};

const getNumberParam = (name: string, fallback: number): number => {
  const value = Number(new URLSearchParams(window.location.search).get(name));
  return Number.isFinite(value) ? value : fallback;
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

const getPlatformKind = (): SplatPlatformKind => {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("platform") ?? params.get("ssogPlatform");
  if (
    explicit === "desktop" ||
    explicit === "mobile" ||
    explicit === "ios" ||
    explicit === "android" ||
    explicit === "quest" ||
    explicit === "vision"
  ) {
    return explicit;
  }

  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean }; maxTouchPoints?: number };
  const userAgent = navigator.userAgent;
  const isQuest = /OculusBrowser|Quest/i.test(userAgent);
  const isVision = /Vision Pro|Apple Vision|xros/i.test(userAgent);
  const isAndroid = /Android/i.test(userAgent);
  const isIphoneOrIpod = /iPhone|iPod/i.test(userAgent);
  const isIpad =
    /iPad/i.test(userAgent) ||
    (navigator.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);
  const isMobile = nav.userAgentData?.mobile ?? /Mobile/i.test(userAgent);

  if (isQuest) {
    return "quest";
  }
  if (isVision) {
    return "vision";
  }
  if (isAndroid) {
    return "android";
  }
  if (isIphoneOrIpod || isIpad) {
    return "ios";
  }
  if (isMobile) {
    return "mobile";
  }
  return "desktop";
};

const getDeviceTier = (): SplatDeviceTier => {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("deviceTier") ?? params.get("ssogDeviceTier");
  if (explicit === "low" || explicit === "standard" || explicit === "high") {
    return explicit;
  }

  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } };
  const platform = getPlatformKind();
  const memoryGb = nav.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;

  if (platform !== "desktop" || memoryGb <= 4 || cores <= 4) {
    return "low";
  }
  if (memoryGb >= 12 && cores >= 8) {
    return "high";
  }
  return "standard";
};

const getPlatformQualityProfileForPreset = (preset: SplatQualityPreset): PlatformQualityProfile => {
  const platform = getPlatformKind();
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
  const platformBudgets: Record<SplatPlatformKind, Record<SplatQualityPreset, number>> = {
    desktop: budgets[deviceTier],
    mobile: {
      fast: 500_000,
      balanced: 1_000_000,
      full: 1_500_000,
      idle: 2_000_000,
      screenshot: 2_500_000,
    },
    ios: {
      fast: 600_000,
      balanced: 1_200_000,
      full: 1_800_000,
      idle: 2_400_000,
      screenshot: 3_000_000,
    },
    android: {
      fast: 500_000,
      balanced: 1_000_000,
      full: 1_500_000,
      idle: 2_000_000,
      screenshot: 2_500_000,
    },
    quest: {
      fast: 450_000,
      balanced: 900_000,
      full: 1_400_000,
      idle: 1_800_000,
      screenshot: 2_200_000,
    },
    vision: {
      fast: 1_000_000,
      balanced: 1_800_000,
      full: 2_800_000,
      idle: 3_500_000,
      screenshot: 4_500_000,
    },
  };
  const budget = platformBudgets[platform][preset];
  return {
    preset,
    platform,
    deviceTier,
    renderSplatBudget: budget,
    ssogSplatBudget: budget,
  };
};

const getPlatformQualityProfile = (): PlatformQualityProfile => getPlatformQualityProfileForPreset(getQualityPreset());

const getSplatShaderQualityProfile = (): SplatShaderQualityProfile => {
  const preset = getQualityPreset();
  const platform = getPlatformKind();
  const deviceTier = getDeviceTier();
  const base: Record<SplatQualityPreset, SplatShaderQualityProfile> = {
    fast: {
      minAlpha: 1.5 / 255,
      minPixelRadius: 2.5,
      maxPixelRadius: 56,
      maxStdDev: 2.2,
      clipXY: 1.08,
      blurAmount: 0.9,
      preBlurAmount: 0.2,
      alphaClip: 1.5 / 255,
      maxDevicePixelRatio: 1.15,
    },
    balanced: {
      minAlpha: 1 / 255,
      minPixelRadius: 2,
      maxPixelRadius: 96,
      maxStdDev: 2.8284271247461903,
      clipXY: 1.15,
      blurAmount: 1,
      preBlurAmount: 0.3,
      alphaClip: 1 / 255,
      maxDevicePixelRatio: 1.5,
    },
    full: {
      minAlpha: 0.75 / 255,
      minPixelRadius: 1.5,
      maxPixelRadius: 128,
      maxStdDev: 3,
      clipXY: 1.22,
      blurAmount: 1,
      preBlurAmount: 0.3,
      alphaClip: 0.75 / 255,
      maxDevicePixelRatio: 2,
    },
    idle: {
      minAlpha: 0.5 / 255,
      minPixelRadius: 1.25,
      maxPixelRadius: 144,
      maxStdDev: 3.1,
      clipXY: 1.25,
      blurAmount: 1.03,
      preBlurAmount: 0.32,
      alphaClip: 0.5 / 255,
      maxDevicePixelRatio: 2,
    },
    screenshot: {
      minAlpha: 0.25 / 255,
      minPixelRadius: 1,
      maxPixelRadius: 192,
      maxStdDev: 3.2,
      clipXY: 1.3,
      blurAmount: 1.05,
      preBlurAmount: 0.35,
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
  const platformScale =
    platform === "quest"
      ? { min: 1.25, max: 0.65, dpr: 0.75, alpha: 1.35, stdDev: 0.82, clip: 0.96, blur: 0.95 }
      : platform === "ios" || platform === "android" || platform === "mobile"
        ? { min: 1.15, max: 0.8, dpr: 0.85, alpha: 1.15, stdDev: 0.9, clip: 0.98, blur: 0.97 }
        : platform === "vision"
          ? { min: 1, max: 0.9, dpr: 0.9, alpha: 1.05, stdDev: 0.95, clip: 1, blur: 1 }
          : { min: 1, max: 1, dpr: 1, alpha: 1, stdDev: 1, clip: 1, blur: 1 };
  const selected = base[preset];
  const alphaClip = selected.alphaClip * tierScale.alpha * platformScale.alpha;
  return {
    minAlpha: getPositiveNumberParam("splatMinAlpha", selected.minAlpha * tierScale.alpha * platformScale.alpha),
    minPixelRadius: getPositiveNumberParam("splatMinPixelRadius", selected.minPixelRadius * tierScale.min * platformScale.min),
    maxPixelRadius: getPositiveNumberParam("splatMaxPixelRadius", selected.maxPixelRadius * tierScale.max * platformScale.max),
    maxStdDev: getPositiveNumberParam("splatMaxStdDev", selected.maxStdDev * platformScale.stdDev),
    clipXY: Math.max(0.9, getPositiveNumberParam("splatClipXY", selected.clipXY * platformScale.clip)),
    blurAmount: Math.max(0.5, getPositiveNumberParam("splatBlurAmount", selected.blurAmount * platformScale.blur)),
    preBlurAmount: Math.max(0, getNumberParam("splatPreBlurAmount", selected.preBlurAmount)),
    alphaClip: getPositiveNumberParam("splatAlphaClip", alphaClip),
    maxDevicePixelRatio: getPositiveNumberParam(
      "maxDevicePixelRatio",
      Math.max(1, selected.maxDevicePixelRatio * tierScale.dpr * platformScale.dpr),
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

const getQualitySplatBudgetForPreset = (
  sourceSplats: number,
  preset: SplatQualityPreset,
  options: { referenceParam?: string } = {},
): number => {
  const params = new URLSearchParams(window.location.search);
  const explicitBudget = getExplicitSplatBudget();
  if (explicitBudget !== undefined) {
    return Math.min(sourceSplats, explicitBudget);
  }
  if (options.referenceParam && params.get(options.referenceParam) === "true") {
    return sourceSplats;
  }
  return Math.min(sourceSplats, getPlatformQualityProfileForPreset(preset).renderSplatBudget);
};

export {
  getDeviceTier,
  getExplicitSplatBudget,
  getPlatformKind,
  getPlatformQualityProfile,
  getPlatformQualityProfileForPreset,
  getQualityPreset,
  getQualitySplatBudget,
  getQualitySplatBudgetForPreset,
  getSplatShaderQualityProfile,
};
export type { PlatformQualityProfile, SplatDeviceTier, SplatPlatformKind, SplatQualityPreset, SplatShaderQualityProfile };
