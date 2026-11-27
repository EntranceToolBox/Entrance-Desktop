const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const build = path.join(root, 'Platform/build/macos');
const dist = path.join(root, 'Desktop/dist');
const source = path.join(root, 'Entrance');
const version = require('../../package.json').version;
const native = process.platform === 'darwin';
const minimum = '13.5'; // Minimum supported by the pinned Node release.
const appName = 'Entrance Desktop';
const nodeVersion = '24.22.3';
const checksums = {
  x64: '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7',
  arm64: 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd'
};

function run(program, args, cwd = root) {
  execFileSync(program, args, { cwd, stdio: 'inherit' });
}

function compile(arch, output) {
  const swift = path.join(__dirname, 'main.swift');
  const flags = ['-swift-version', '5', '-O', '-parse-as-library', '-target', arch + '-apple-macos' + minimum];
  if (native) {
    run('xcrun', ['--sdk', 'macosx', 'swiftc', ...flags, swift, '-o', output]);
    return;
  }
  const sdk = process.env.MACOS_SDKROOT || process.env.SDKROOT;
  if (!sdk || !fs.existsSync(path.join(sdk, 'SDKSettings.json'))) {
    throw Error('Set MACOS_SDKROOT to a macOS SDK for Swift cross-compilation.');
  }
  // Keep the Linux Foundation and Dispatch headers out of Darwin module imports.
  const resources = path.join(build, 'swift-resource');
  fs.mkdirSync(resources, { recursive: true });
  const toolchain = JSON.parse(execFileSync('swiftc', ['-print-target-info'])).paths.runtimeResourcePath;
  for (const name of ['clang', 'host']) {
    try { fs.symlinkSync(path.join(toolchain, name), path.join(resources, name)); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const libraries = path.join(sdk, 'usr/lib/swift');
  const object = output + '.o';
  run('swiftc', [...flags, '-sdk', sdk, '-resource-dir', resources, '-I', path.join(libraries, 'shims'),
    '-module-cache-path', path.join(build, 'module-cache'), '-emit-object', swift, '-o', object]);
  const linker = process.env.LD64_LLD || (fs.existsSync('/usr/bin/ld64.lld') ? '/usr/bin/ld64.lld' : 'ld64.lld');
  run(linker, ['-arch', arch, '-platform_version', 'macos', minimum, require(path.join(sdk, 'SDKSettings.json')).Version,
    '-syslibroot', sdk, '-L', libraries, '-rpath', '/usr/lib/swift', '-lSystem', '-adhoc_codesign', object, '-o', output]);
  fs.unlinkSync(object);
}

function installNode(cpu, bin, resources, stage) {
  const name = 'node-v' + nodeVersion + '-darwin-' + cpu;
  const archive = name + '.tar.gz';
  const downloads = path.join(build, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const cached = path.join(downloads, archive);
  const valid = file => fs.existsSync(file) && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === checksums[cpu];
  if (!valid(cached)) {
    const download = path.join(stage, archive);
    run('curl', ['-fLSs', '--retry', '3', '-o', download, 'https://nodejs.org/dist/v' + nodeVersion + '/' + archive]);
    if (!valid(download)) throw Error('Invalid SHA-256 checksum for ' + archive);
    fs.renameSync(download, cached);
  }
  run('tar', ['-xzf', cached, '-C', stage, name + '/bin/node', name + '/LICENSE']);
  fs.renameSync(path.join(stage, name, 'bin/node'), path.join(bin, 'node'));
  fs.renameSync(path.join(stage, name, 'LICENSE'), path.join(resources, 'node-LICENSE'));
}

function installBackend(cpu, directory) {
  for (const name of ['package.json', 'package-lock.json', 'LICENSE', 'server.js', 'flash-debug.js',
    'local-shell.js', 'remote-serial.js', 'vnc.js', 'public', 'api']) {
    fs.cpSync(path.join(source, name), path.join(directory, name), { recursive: true });
  }
  run(process.execPath, [process.env.npm_execpath, 'ci', '--os=darwin', '--cpu=' + cpu, '--omit=dev', '--omit=optional',
    '--ignore-scripts', '--prefer-offline', '--replace-registry-host=always', '--no-audit', '--no-fund', '--no-bin-links'], directory);
  const prebuilds = ['argon2', '@serialport/bindings-cpp'].map(name => path.join(directory, 'node_modules', name, 'prebuilds'));
  const addons = [];
  for (const location of prebuilds) {
    const matching = [];
    for (const tuple of fs.readdirSync(location)) {
      const dir = path.join(location, tuple);
      if (tuple === 'darwin-' + cpu || tuple === 'darwin-x64+arm64') {
        for (const file of fs.readdirSync(dir)) {
          if (file.endsWith('.node')) matching.push(path.join(dir, file));
        }
      } else {
        fs.rmSync(dir, { recursive: true });
      }
    }
    if (!matching.length) throw Error('Missing Darwin native addon for ' + cpu + ' in ' + location);
    addons.push(...matching);
  }
  return addons;
}

function bundle(arch, stage) {
  const cpu = arch === 'x86_64' ? 'x64' : arch;
  const app = path.join(stage, arch, appName + '.app');
  const contents = path.join(app, 'Contents');
  const bin = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const backend = path.join(resources, 'Entrance');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(backend, { recursive: true });
  const plist = fs.readFileSync(path.join(__dirname, 'Info.plist'), 'utf8')
    .replaceAll('@RELEASE@', version.split('-')[0])
    .replace('@VERSION@', version).replace('@MINIMUM@', minimum);
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist);
  fs.copyFileSync(path.join(root, 'Share/MacOS/entrance-desktop.icns'), path.join(resources, 'entrance-desktop.icns'));
  fs.copyFileSync(path.join(root, 'Platform/backend.cjs'), path.join(resources, 'backend.cjs'));
  const client = path.join(bin, appName);
  compile(arch, client);
  installNode(cpu, bin, resources, stage);
  const addons = installBackend(cpu, backend);
  for (const file of [client, path.join(bin, 'node'), ...addons]) {
    run(native ? 'lipo' : 'llvm-lipo', [file, '-verify_arch', arch]);
  }
  if (native) {
    run('codesign', ['--force', '--sign', '-', app]);
    run('codesign', ['--verify', '--strict', app]);
  } else {
    const localSigner = path.join(build, 'tools/rcodesign');
    const signer = process.env.RCODESIGN || (fs.existsSync(localSigner) ? localSigner : 'rcodesign');
    run(signer, ['sign', app]);
  }
  return app;
}

function main(command) {
  fs.mkdirSync(build, { recursive: true });
  const host = process.arch === 'x64' ? 'x86_64' : process.arch;
  if (command === 'start' || command === 'dev') {
    const client = path.join(build, appName);
    compile(host, client);
    run(client, ['--development', process.execPath, path.join(root, 'Platform/backend.cjs'), source]);
    return;
  }
  fs.mkdirSync(dist, { recursive: true });
  const stage = fs.mkdtempSync(path.join(dist, '.mac-build-'));
  try {
    if (command === 'pack') {
      const app = bundle(host, stage);
      const destination = path.join(dist, 'darwin-' + host, path.basename(app));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(app, destination);
      console.log(destination);
      return;
    }
    const archives = [];
    for (const arch of ['x86_64', 'arm64']) {
      const app = bundle(arch, stage);
      const name = 'Entrance-Desktop-' + version + '-macOS-' + arch + '.zip';
      const archive = path.join(stage, name);
      if (native) run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
      else run('zip', ['-q', '-r', '-y', archive, path.basename(app)], path.dirname(app));
      archives.push(name);
    }
    for (const name of archives) {
      fs.renameSync(path.join(stage, name), path.join(dist, name));
      console.log(path.join(dist, name));
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

main(process.argv[2]);
