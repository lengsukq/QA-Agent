export const RUNTIME_REPORT_GENERATOR = 'qa-agent-runtime' as const;

export function runtimeReportMarker(runId: string): string {
  return `<!-- qa-agent-runtime-report:${runId} -->`;
}

export function hasRuntimeReportMarker(text: string, runId: string): boolean {
  return text.includes(runtimeReportMarker(runId));
}
