const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const runtimeRoots = ['electron', 'src', 'public'];
const runtimeTools = ['scripts/pair-companion.cjs'];

function isSource(file) {
  return runtimeRoots.some((base) => file.startsWith(base + '/')) || runtimeTools.includes(file);
}

function declarationFiles(base = root) {
  const ts = require('typescript');
  const excluded = [];
  for (const relative of fs.readdirSync(path.join(base, 'src'), { recursive: true })) {
    if (!/\.tsx?$/.test(relative)) continue;
    const file = path.join('src', relative).replaceAll('\\', '/');
    if (file.endsWith('.d.ts')) { excluded.push(file); continue; }
    const source = fs.readFileSync(path.join(base, file), 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    // Exclude only files whose AST consists entirely of erased declarations.
    // An added runtime export immediately puts the file into the denominator.
    if (parsed.statements.every((node) => ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) || ts.isImportDeclaration(node) && node.importClause?.isTypeOnly || ts.isExportDeclaration(node) && node.isTypeOnly)) excluded.push(file);
  }
  return excluded;
}


function executableFiles(base = root) {
  const declarations = new Set(declarationFiles(base));
  const files = runtimeRoots.flatMap((folder) => fs.existsSync(path.join(base, folder)) ? fs.readdirSync(path.join(base, folder), { recursive: true }).map((file) => `${folder}/${file.replaceAll('\\', '/')}`) : []);
  files.push(...runtimeTools.filter((file) => fs.existsSync(path.join(base, file))));
  return files.filter((file) => /\.(?:cjs|mjs|js|py|tsx?)$/.test(file) && !declarations.has(file)).sort();
}
function javascriptFiles(base = root) { return executableFiles(base).filter((file) => !file.endsWith('.py')); }
function pythonFiles(base = root) { return executableFiles(base).filter((file) => file.endsWith('.py')); }
module.exports = { isSource, declarationFiles, executableFiles, javascriptFiles, pythonFiles };
