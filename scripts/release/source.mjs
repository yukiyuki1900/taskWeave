import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { output: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) console.log('npm run release:source -- [--output .cache/releases]\n仅导出已提交 HEAD 的公开源码白名单，不包含 Git 历史、忽略文件或工作区数据；拒绝未提交修改。');
else {
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' }).trim()) throw new Error('请先提交本次源码变更，再导出 HEAD；不会悄悄漏掉未提交内容');
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(version)) throw new Error('版本无效');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const paths = ['apps', 'packages', 'bin', 'docs', 'examples', 'scripts', 'tests', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.env.example'];
  const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...paths], { encoding: 'utf8' }).trim().split('\n');
  for (const file of tracked) {
    if (file.split('/').some(part => ['node_modules', '.taskweave', '.cache', '.demo', '.git', 'dist', 'dist-demo'].includes(part)) || /(^|\/)\.env(?:\.|$)/.test(file) && file !== '.env.example' || /\.(pem|key|p12|pfx)$/i.test(file)) throw new Error(`拒绝导出运行数据或凭据文件：${file}`);
  }
  const directory = path.resolve(values.output ?? '.cache/releases'); await mkdir(directory, { recursive: true });
  const name = `TaskWeave-v${version}-source.tar.gz`; const archive = path.join(directory, name);
  execFileSync('git', ['archive', '--format=tar.gz', `--prefix=TaskWeave-v${version}/`, `--output=${archive}`, 'HEAD', '--', ...paths]);
  const bytes = await readFile(archive); const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(archive + '.sha256', `${sha256}  ${name}\n`);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version, commit, archive: name, bytes: bytes.length, sha256, trackedFiles: tracked.length, gitHistory: false, published: false }, null, 2) + '\n');
  console.log(JSON.stringify({ archive, bytes: bytes.length, sha256, commit, published: false }, null, 2));
}
