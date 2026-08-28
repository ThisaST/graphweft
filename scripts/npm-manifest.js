// One package.json serves two very different registries: the VS Code Marketplace (via vsce)
// and npm. A few fields must differ between them, so for `npm pack`/`npm publish` only we
// swap in the npm-facing values and restore the originals afterwards.
//
//   prepack  -> node scripts/npm-manifest.js pack
//   postpack -> node scripts/npm-manifest.js restore
//
// vsce reads package.json directly and never runs these hooks, so the .vsix keeps the
// Marketplace values. If a pack is interrupted between the two phases, run
// `node scripts/npm-manifest.js restore` (or `git checkout package.json README.md`).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const readme = path.join(root, 'README.md');
const npmReadme = path.join(root, 'npm-readme.md');
const readmeBackup = path.join(root, '.README.original.bak');
const manifest = path.join(root, 'package.json');
const manifestBackup = path.join(root, '.package.json.original.bak');

// npm-only manifest values. `main` matters because Node falls back to it when a caller
// resolves the package by path rather than by name, and out/extension.js is not published.
// Only `main` is swapped here. `description` and `keywords` deliberately are NOT:
// npm captures registry metadata from package.json BEFORE prepack runs, so swapping them
// changes the tarball but never the npm page. They live in package.json worded to serve
// both registries. `main` is different: Node reads it from the *tarball*, so the swap
// does take effect where it matters (resolving the package by path rather than by name).
const npmFields = {
  main: './out/index.js',
};

const mode = process.argv[2];

if (mode === 'pack') {
  if (!fs.existsSync(npmReadme)) {
    throw new Error('npm-readme.md is missing — cannot build the npm readme.');
  }
  // Never clobber an existing backup: that means a previous pack did not restore.
  if (!fs.existsSync(readmeBackup)) fs.copyFileSync(readme, readmeBackup);
  if (!fs.existsSync(manifestBackup)) fs.copyFileSync(manifest, manifestBackup);

  fs.copyFileSync(npmReadme, readme);

  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  Object.assign(pkg, npmFields);
  fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);

  process.stdout.write('npm-manifest: npm readme + manifest fields in place\n');
} else if (mode === 'restore') {
  if (fs.existsSync(readmeBackup)) {
    fs.copyFileSync(readmeBackup, readme);
    fs.rmSync(readmeBackup);
  }
  if (fs.existsSync(manifestBackup)) {
    fs.copyFileSync(manifestBackup, manifest);
    fs.rmSync(manifestBackup);
  }
  process.stdout.write('npm-manifest: originals restored\n');
} else {
  throw new Error(`npm-manifest: expected "pack" or "restore", got "${mode}"`);
}
