import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostConfig, type HostConfigurator } from './registry.ts';
import { copySkill, copySubSkills, detected, managedTemplate, requireProjectPath, sharedGuidance } from './shared.ts';

export const codexConfigurator: HostConfigurator = {
  configure(options) {
    const scope = options.scope ?? 'user';
    if (scope === 'project') {
      const project = requireProjectPath(options.projectPath);
      const roots = [join(project, '.codex', 'skills', 'qa-agent'), join(project, '.agents', 'skills', 'qa-agent')];
      const paths = [...roots];
      roots.forEach(path => { copySkill(path, Boolean(options.force)); paths.push(...copySubSkills(join(path, '..'), Boolean(options.force))); });
      return { host: 'codex', paths, message: 'Installed project Codex Skill, shared Agent Skill, and subskills.' };
    }
    const destination = join(options.path ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills'), 'qa-agent');
    copySkill(destination, Boolean(options.force));
    const paths = [destination, ...copySubSkills(join(destination, '..'), Boolean(options.force))];
    return { host: 'codex', paths, message: 'Installed Codex QA Agent skill and subskills.' };
  },
  collectManagedTemplates() { return managedTemplate(hostConfig('codex'), sharedGuidance); },
  detect(projectRoot) { return detected(hostConfig('codex'), projectRoot); },
};
