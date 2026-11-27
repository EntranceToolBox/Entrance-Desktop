// Attach the bundled frontend to the existing API-only HTTP server. Stdout is
// a private, one-line readiness channel to the parent window.
const { randomBytes } = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const serverFile = path.resolve(process.argv[2], 'server.js');
const serve = createRequire(serverFile)('express').static(path.join(path.dirname(serverFile), 'public'));
const port = process.env.PORT || new URL(process.env.ENTRANCE_URL || 'http://127.0.0.1:3000').port || '3000';
const origin = 'http://127.0.0.1:' + port;
const secret = randomBytes(32).toString('hex');
let ticket = '/' + randomBytes(32).toString('hex');
// Electron releases used this SSH key when the user supplied no override.
// Existing encrypted saved hosts still need it. Fresh profiles use the
// backend's per-user generated key file.
const data = process.env.ENTRANCE_DATA_DIR;
if (data && !process.env.SSH_PASSWORD_KEY && fs.existsSync(path.join(data, 'users.json')) &&
    !fs.existsSync(path.join(data, '.ssh_password_key'))) {
  process.env.SSH_PASSWORD_KEY = '0123456789abcdef'.repeat(4);
}
Object.assign(process.env, {
  AUTH_SECRET: process.env.AUTH_SECRET || randomBytes(32).toString('hex'),
  PORT: port,
  ENTRANCE_HOST: '127.0.0.1',
  ENTRANCE_DESKTOP_API_ONLY: '1',
  ENTRANCE_DESKTOP_NOLOGIN: '1',
  ENTRANCE_DESKTOP_ALLOWED_ORIGIN: origin,
  ENTRANCE_DESKTOP_BOOTSTRAP_SECRET: secret,
  ENTRANCE_DESKTOP_VERSION: process.env.ENTRANCE_DESKTOP_VERSION || '0.1.7-1'
});
console.log = console.error;
const createServer = http.createServer;
http.createServer = function (app) {
  http.createServer = createServer;
  const server = createServer((req, res) => {
    if (req.headers.host !== '127.0.0.1:' + port) {
      res.writeHead(403).end();
    } else if (req.url === ticket && req.method === 'GET') {
      ticket = null;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Entrance</title><script>
        history.replaceState(null, '', '/');
        (async () => {
          const r = await fetch('/api/auth/desktop/bootstrap', { method: 'POST',
            headers: { 'X-Entrance-Desktop-Secret': '${secret}' } });
          if (!r.ok) throw Error('Desktop session failed (' + r.status + ')');
          const session = await r.json();
          localStorage.setItem('authToken', session.token);
          localStorage.setItem('authSecretFingerprint', session.authSecretFingerprint);
          location.replace('/index.html?desktopMode=1');
        })().catch(error => document.body.textContent = error.message);
        </script><body>Starting Entrance…</body>`);
    } else {
      serve(req, res, () => app(req, res));
    }
  });
  server.once('listening', () => {
    process.stdout.write(origin + ticket + '\n');
  });
  return server;
};
require(serverFile);
