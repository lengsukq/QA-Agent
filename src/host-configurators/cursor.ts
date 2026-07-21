import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { hostConfig, type HostConfigurator } from './registry.ts';
import { copySkill, copySubSkills, detected, managedTemplate, requireProjectPath, renderCursorRule, sharedGuidance, writeManagedText } from './shared.ts';

export const cursorConfigurator: HostConfigurator = {
  configure(options) {
    if (options.scope === 'user') throw new Error('Cursor user Rules are managed as plain text in Cursor Settings > Rules, not as a file-based Skill. Use --scope project for the generated Rule and Command.');
    const project = requireProjectPath(options.projectPath);
    const force = Boolean(options.force);
    const rule = join(project, '.cursor', 'rules', 'qa-agent.mdc');
    const command = join(project, '.cursor', 'commands', 'qa-agent-cli.md');
    const skill = join(project, '.cursor', 'skills', 'qa-agent');
    writeManagedText(rule, renderCursorRule(hostConfig('cursor')), force);
    writeManagedText(command, sharedGuidance, force);
    const legacyCommand = join(project, '.cursor', 'commands', 'qa-agent.md');
    if (existsSync(legacyCommand) && (force || readFileSync(legacyCommand, 'utf8') === sharedGuidance)) unlinkSync(legacyCommand);
    copySkill(skill, force);
    const subskills = copySubSkills(join(project, '.cursor', 'skills'), force);
    return { host: 'cursor', paths: [rule, command, skill, ...subskills], message: 'Installed Cursor QA Agent rule, CLI command, main skill, and subskills.' };
  },
  collectManagedTemplates() { return managedTemplate(hostConfig('cursor'), renderCursorRule(hostConfig('cursor'))); },
  detect(projectRoot) { return detected(hostConfig('cursor'), projectRoot); },
};
