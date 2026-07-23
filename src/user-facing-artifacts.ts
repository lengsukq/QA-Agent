import { relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { UserFacingArtifact, UserFacingArtifactKind } from './types.ts';

function markdownTarget(value: string): string {
  return encodeURI(value).replace(/\(/g, '%28').replace(/\)/g, '%29');
}

export function userFacingArtifact(root: string, path: string, label: string, kind: UserFacingArtifactKind): UserFacingArtifact {
  const workspacePath = relative(root, path).split(sep).join('/');
  const fileUrl = pathToFileURL(path).href;
  return {
    kind,
    label,
    path,
    workspacePath,
    fileUrl,
    markdownLink: `[${label}](${markdownTarget(workspacePath)})`,
    absoluteMarkdownLink: `[${label}](${fileUrl})`,
  };
}

export function artifactLinksSentence(artifacts: UserFacingArtifact[]): string {
  return artifacts.map(artifact => artifact.markdownLink).join(' · ');
}
