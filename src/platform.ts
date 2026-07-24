export const SUPPORTED_PLATFORMS = ['web', 'ios'] as const;
export type SupportedPlatform = typeof SUPPORTED_PLATFORMS[number];
export const PLATFORM_DECLARATION_PROMPT_ZH = '请明确声明本次测试平台：Web 或 iOS Simulator';
export const PLATFORM_DECLARATION_PROMPT_EN = 'Explicitly declare the test platform: Web or iOS Simulator.';

export function isSupportedPlatform(platform: string | undefined): platform is SupportedPlatform {
  return Boolean(platform && SUPPORTED_PLATFORMS.includes(platform as SupportedPlatform));
}

export function assertSupportedPlatform(platform: string | undefined, label = 'platform'): asserts platform is SupportedPlatform {
  if (!isSupportedPlatform(platform)) {
    throw new Error(`${label} must be web or ios. Run qa-agent doctor --platforms web or ios to diagnose the supported built-in Runner.`);
  }
}

export function normalizeSupportedPlatforms(platforms: string[] | undefined, fallback: SupportedPlatform[] = ['web'], label = 'platforms'): SupportedPlatform[] {
  const values = [...new Set(platforms?.length ? platforms : fallback)];
  const unsupported = values.filter(platform => !isSupportedPlatform(platform));
  if (unsupported.length) {
    throw new Error(`${label} contains unsupported platform(s): ${unsupported.join(', ')}. QA Agent currently supports only Web and iOS Simulator. Run qa-agent doctor --platforms web or ios after choosing a supported platform.`);
  }
  return values as SupportedPlatform[];
}

export function platformMismatchAdvice(configured: string | undefined, requested: string | undefined): string {
  const configuredLabel = configured ?? 'the current Task';
  const requestedLabel = requested ?? 'the requested platform';
  return `Platform mismatch: ${configuredLabel} is configured, but ${requestedLabel} was requested. Stop UI execution, run qa-agent doctor --platforms ${requestedLabel}, reapply the PlanDraft with the correct platform, then run qa-agent test --platform ${requestedLabel}. Do not call MCP, Playwright, xcrun, idb, or any other UI tool directly.`;
}

export function platformDeclarationAdvice(): string {
  return `${PLATFORM_DECLARATION_PROMPT_ZH}。将平台声明写入 PlanDraft.platformDeclaration.platform，并让 scope.platforms 只包含同一个平台；未声明前不能确认或执行测试。`;
}
