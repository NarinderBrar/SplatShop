type SplatQualityPreset = "fast" | "balanced" | "full" | "idle" | "screenshot";
type SplatDeviceTier = "low" | "standard" | "high";

type PlatformQualityProfile = {
  preset: SplatQualityPreset;
  deviceTier: SplatDeviceTier;
  renderSplatBudget: number;
  ssogSplatBudget: number;
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
};
export type { PlatformQualityProfile, SplatDeviceTier, SplatQualityPreset };
