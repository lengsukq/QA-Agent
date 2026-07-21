import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostConfig, type HostConfigurator } from './registry.ts';
import { copyMainSkill, copySubSkills, detected, managedTemplate, requireProjectPath, renderCopilotAgent, writeManagedText } from './shared.ts';

export const copilotConfigurator: HostConfigurator = {
  configure(options) {
    const project = options.scope === 'user' ? undefined : requireProjectPath(options.projectPath);
    const force = Boolean(options.force);
    const skill = options.scope === 'user' ? join(homedir(), '.copilot', 'skills', 'qa-agent') : join(project!, '.github', 'skills', 'qa-agent');
    const agent = options.scope === 'user' ? join(homedir(), '.copilot', 'agents', 'qa-agent.agent.md') : join(project!, '.github', 'agents', 'qa-agent.agent.md');
    const prompt = options.scope === 'user' ? join(homedir(), '.copilot', 'prompts', 'qa-agent.prompt.md') : join(project!, '.github', 'prompts', 'qa-agent.prompt.md');
    copyMainSkill(skill, force); const subskills = copySubSkills(join(skill, '..'), force); writeManagedText(agent, renderCopilotAgent(hostConfig('copilot')), force); writeManagedText(prompt, renderCopilotAgent(hostConfig('copilot')), force);
    return { host: 'copilot', paths: [skill, ...subskills, agent, prompt], message: 'Installed GitHub Copilot QA skill, subskills, custom agent, and prompt.' };
  },
  collectManagedTemplates() { return managedTemplate(hostConfig('copilot'), renderCopilotAgent(hostConfig('copilot'))); },
  detect(projectRoot) { return detected(hostConfig('copilot'), projectRoot); },
};
