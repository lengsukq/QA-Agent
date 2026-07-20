import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostConfig, type HostConfigurator } from './registry.ts';
import { copySkill, detected, managedTemplate, requireProjectPath, sharedGuidance } from './shared.ts';

export const codexConfigurator: HostConfigurator = {
  configure(options) {
    const scope = options.scope ?? 'user';
    if (scope === 'project') {
      const project = requireProjectPath(options.projectPath);
      const paths = [join(project, '.codex', 'skills', 'qa-agent'), join(project, '.agents', 'skills', 'qa-agent')];
      paths.forEach(path => copySkill(path, Boolean(options.force)));
      return { host: 'codex', paths, message: 'Installed project Codex Skill and shared Agent Skill.' };
    }
    const destination = join(options.path ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills'), 'qa-agent');
    copySkill(destination, Boolean(options.force));
    return { host: 'codex', paths: [destination], message: 'Installed Codex QA Agent skill.' };
  },
  collectManagedTemplates() { return managedTemplate(hostConfig('codex'), sharedGuidance); },
  detect(projectRoot) { return detected(hostConfig('codex'), projectRoot); },
};
