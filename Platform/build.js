const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.dirname(__dirname);
const command = process.argv[2];
const platform = ({ 'dist:win': 'win32', 'dist:linux': 'linux', 'dist:darwin': 'darwin' })[command] || process.platform;

const crossWindows = process.platform === 'linux' && platform === 'win32';
const build = crossWindows ? path.join(__dirname, 'build', 'windows-x64') : path.join(__dirname, 'build');

function run(file, args) {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
function npm(args) {
  run(process.execPath, [process.env.npm_execpath, ...args]);
}
if (command === 'install:all') {
  npm(['install', '--prefix', 'Entrance']);
  if (platform === 'darwin') npm(['install', '--prefix', 'Platform/macOS']);
} else if (platform === 'darwin') {
  npm(['--prefix', 'Platform/macOS', 'run', command]);
} else {
  if (!crossWindows && platform !== process.platform) throw Error('Build the native package on its target OS.');
  const configure = ['-S', 'Platform', '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DNODE_EXECUTABLE=' + process.execPath];
  if (crossWindows) {
    const backend = path.join(build, 'backend');
    fs.mkdirSync(backend, { recursive: true });
    for (const manifest of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(root, 'Entrance', manifest), path.join(backend, manifest));
    }
    // The locked Argon2 and serialport packages ship Windows N-API binaries.
    // Running install scripts on Linux would build host addons instead.
    npm(['ci', '--prefix', backend, '--os=win32', '--cpu=x64', '--omit=dev', '--omit=optional',
      '--ignore-scripts', '--prefer-offline', '--replace-registry-host=always', '--no-audit', '--no-fund']);
    const modules = path.join(backend, 'node_modules');
    for (const addon of ['argon2/prebuilds/win32-x64/argon2.glibc.node',
      '@serialport/bindings-cpp/prebuilds/win32-x64/node.napi.node']) {
      fs.accessSync(path.join(modules, addon));
    }
    configure.push('-DCMAKE_TOOLCHAIN_FILE=' + path.join(__dirname, 'Windows/mingw-x64.cmake'),
      '-DBACKEND_MODULES=' + modules);
  }
  run('cmake', configure);
  run('cmake', ['--build', build, '--config', 'Release']);
  if (command === 'start' || command === 'dev') {
    run(path.join(build, 'bin', platform === 'win32' ? 'entrance-desktop.exe' : 'entrance-desktop'), []);
  } else if (command === 'pack') {
    run('cmake', ['--install', build, '--config', 'Release', '--prefix', path.join(root, 'Desktop', 'dist', platform)]);
  } else if (platform === 'linux') {
    run('cmake', ['--build', build, '--target', 'appimage', '--config', 'Release']);
  } else {
    run('cmake', ['--build', build, '--target', 'installer', '--config', 'Release']);
  }
}
