import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostConfig, type HostConfigurator } from './registry.ts';
import { copySkill, copySubSkills, detected, managedTemplate, requireProjectPath, sharedGuidance } from './shared.ts';

export const agentsConfigurator: HostConfigurator = {
  configure(options) {
    const project = options.scope === 'user' ? undefined : requireProjectPath(options.projectPath);
    const destination = options.scope === 'user' ? join(homedir(), '.agents', 'skills', 'qa-agent') : join(project!, '.agents', 'skills', 'qa-agent');
    copySkill(destination, Boolean(options.force));
    const paths = [destination, ...copySubSkills(join(destination, '..'), Boolean(options.force))];
    return { host: 'agents', paths, message: 'Installed portable Agent Skills QA package and subskills.' };
  },
  collectManagedTemplates() { return managedTemplate(hostConfig('agents'), sharedGuidance); },
  detect(projectRoot) { return detected(hostConfig('agents'), projectRoot); },
};
