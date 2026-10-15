import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wav': 'audio/wav', '.png': 'image/png', '.svg': 'image/svg+xml',
};

/** Serve `root` read-only on 127.0.0.1 with an ephemeral port. Extra routes: {'/path': (req,res)=>void}. */
export async function startStaticServer(root, routes = {}) {
  const base = fs.realpathSync(root);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (routes[u.pathname]) return routes[u.pathname](req, res, u);
    const file = path.normalize(path.join(base, decodeURIComponent(u.pathname)));
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
