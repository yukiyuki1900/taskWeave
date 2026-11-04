import { parseArgs } from 'node:util';
import path from 'node:path';
import { Workspace, loadConfig } from '@taskweave/adapters';
import { loadSkill, errorMessage, TaskWeaveError } from '@taskweave/core';
import type { IO } from '../presentation/task.ts';

export async function skillsMain(argv: string[], io: IO): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      workspace: { type: 'string' }, config: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
    } });
    if (values.help) { io.out('taskweave skills list | show <skill-id> [--workspace path] [--config path] [--json]'); return 0; }
    const [command, id, ...extra] = positionals;
    if (extra.length || !['list', 'show'].includes(command) || (command === 'show' ? !id : Boolean(id))) throw new TaskWeaveError('INVALID_COMMAND', '使用 skills list 或 skills show <skill-id>');
    const root = path.resolve(values.workspace ?? process.cwd());
    const config = await loadConfig(root, values.config);
    const workspace = new Workspace(root);
    if (command === 'show') {
      const skill = await loadSkill(workspace, config, id!);
      io.out(values.json ? JSON.stringify(skill, null, 2) : `${skill.binding.id}@${skill.binding.version}\n${skill.binding.description}\n\n${skill.content}`);
    } else {
      const skills = [];
      for (const key of Object.keys(config.skills ?? {})) skills.push((await loadSkill(workspace, config, key)).binding);
      io.out(values.json ? JSON.stringify(skills, null, 2) : skills.map(skill => `${skill.id}@${skill.version}  ${skill.description}`).join('\n') || '尚未注册本地 Skill。');
    }
    return 0;
  } catch (error) { io.err(`TaskWeave skills: ${errorMessage(error)}`); return 1; }
}
