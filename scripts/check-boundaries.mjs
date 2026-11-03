import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const layers = {
  '@taskweave/contracts': [],
  '@taskweave/core': ['@taskweave/contracts'],
  '@taskweave/adapters': ['@taskweave/core', '@taskweave/contracts'],
  '@taskweave/evaluation': ['@taskweave/core', '@taskweave/adapters'],
  '@taskweave/cli': ['@taskweave/core', '@taskweave/contracts', '@taskweave/adapters', '@taskweave/evaluation']
};
const workspaces = new Map();
for (const folder of ['apps', 'packages']) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(folder, entry.name);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    if (!Object.hasOwn(layers, manifest.name)) throw new Error(`未定义依赖边界：${manifest.name}`);
    workspaces.set(manifest.name, { directory, manifest });
  }
}
const errors = [];
async function scan(directory, owner) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { await scan(file, owner); continue; }
    if (!/\.(ts|mjs)$/.test(file)) continue;
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const report = message => errors.push(`${file}: ${message}`);
    const check = specifier => {
      if (specifier.startsWith('.')) {
        const target = path.relative(path.resolve(owner.directory), path.resolve(path.dirname(file), specifier));
        if (target.startsWith('..') || path.isAbsolute(target)) report(`跨包相对引用 ${specifier}`);
        return;
      }
      if (specifier.startsWith('@taskweave/')) {
        const [scope, name, ...parts] = specifier.split('/');
        const dependency = `${scope}/${name}`;
        if (!layers[owner.manifest.name].includes(dependency)) report(`不允许依赖 ${dependency}`);
        if (!Object.hasOwn(owner.manifest.dependencies ?? {}, dependency)) report(`未声明依赖 ${dependency}`);
        const target = workspaces.get(dependency);
        const key = parts.length ? './' + parts.join('/') : '.';
        if (!target || !Object.hasOwn(target.manifest.exports, key)) report(`引用未公开的包入口 ${specifier}`);
        return;
      }
      if (owner.manifest.name === '@taskweave/contracts') report(`协议包不允许外部依赖 ${specifier}`);
      if (owner.manifest.name === '@taskweave/core' && !['node:crypto', 'node:path'].includes(specifier)) report(`核心包不允许直接访问基础设施 ${specifier}`);
    };
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) report('动态模块路径无法检查，请使用固定包入口');
        else check(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
for (const owner of workspaces.values()) {
  for (const dependency of Object.keys(owner.manifest.dependencies ?? {}).filter(name => name.startsWith('@taskweave/'))) {
    if (!layers[owner.manifest.name].includes(dependency)) errors.push(`${owner.directory}/package.json: 不允许依赖 ${dependency}`);
  }
  await scan(path.join(owner.directory, 'src'), owner);
}
if (errors.length) throw new Error(errors.join('\n'));
process.stdout.write(`模块依赖边界通过（${workspaces.size} 个 workspace）\n`);
