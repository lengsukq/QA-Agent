import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostConfig, type HostConfigurator } from './registry.ts';
import { copyMainSkill, copySubSkills, detected, managedTemplate, requireProjectPath, renderGeminiCommand, writeManagedText } from './shared.ts';

export const geminiConfigurator: HostConfigurator = {
  configure(options) {
    const project = options.scope === 'user' ? undefined : requireProjectPath(options.projectPath);
    const force = Boolean(options.force);
    const command = options.scope === 'user' ? join(homedir(), '.gemini', 'commands', 'qa-agent.toml') : join(project!, '.gemini', 'commands', 'qa-agent.toml');
    const shared = options.scope === 'user' ? join(homedir(), '.agents', 'skills', 'qa-agent') : join(project!, '.agents', 'skills', 'qa-agent');
    writeManagedText(command, renderGeminiCommand(hostConfig('gemini')), force); copyMainSkill(shared, force); const subskills = copySubSkills(join(shared, '..'), force);
    return { host: 'gemini', paths: [command, shared, ...subskills], message: 'Installed Gemini CLI /qa-agent command and shared Agent Skill subskills. Run /commands reload in Gemini CLI.' };
  },
  collectManagedTemplates() { return managedTemplate(hostConfig('gemini'), renderGeminiCommand(hostConfig('gemini'))); },
  detect(projectRoot) { return detected(hostConfig('gemini'), projectRoot); },
};
