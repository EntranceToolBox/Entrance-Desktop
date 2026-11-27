const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { build, Platform } = require('electron-builder');

async function packageApp() {
  const dist = path.resolve(__dirname, '../../Desktop/dist');
  await fs.mkdir(dist, { recursive: true });
  const stage = await fs.mkdtemp(path.join(dist, '.mac-build-'));
  const name = 'Entrance Desktop.app';
  const destination = path.join(dist, name);
  const archive = name + '.zip';
  const stagedArchive = path.join(stage, archive);
  const previous = path.join(stage, 'previous.app');
  let hasBackup = false;
  try {
    await build({
      projectDir: __dirname,
      targets: Platform.MAC.createTarget('dir'),
      publish: 'never',
      config: { directories: { output: stage } }
    });
    const entries = await fs.readdir(stage, { withFileTypes: true });
    const output = entries.find(entry => entry.isDirectory() && /^mac(?:-|$)/.test(entry.name));
    if (!output) throw Error('Electron did not produce a macOS output directory.');
    const bundle = path.join(stage, output.name, name);
    await fs.access(path.join(bundle, 'Contents/Info.plist'));
    if (process.platform === 'darwin') {
      execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, stagedArchive]);
    } else {
      execFileSync('zip', ['-q', '-r', '-y', stagedArchive, name], { cwd: path.dirname(bundle) });
    }
    try {
      await fs.rename(destination, previous);
      hasBackup = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.rename(bundle, destination);
      try {
        await fs.rename(stagedArchive, path.join(dist, archive));
      } catch (error) {
        await fs.rename(destination, bundle);
        throw error;
      }
    } catch (error) {
      if (hasBackup) {
        await fs.rename(previous, destination);
        hasBackup = false;
      }
      throw error;
    }
    hasBackup = false;
    console.log(destination);
    console.log(path.join(dist, archive));
  } finally {
    if (!hasBackup) await fs.rm(stage, { recursive: true, force: true });
  }
}

packageApp().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
