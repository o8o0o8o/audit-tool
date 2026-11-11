import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 4178;
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
const staticFiles = { '/': 'index.html', '/index.html': 'index.html', '/small.png': 'small.png' };

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const origin = `http://${req.headers.host ?? `localhost:${port}`}`;

  if (path === '/robots.txt') {
    const body = (await readFile(join(root, 'robots.txt'), 'utf8')).replaceAll('{{ORIGIN}}', origin);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(body);
    return;
  }
  if (path === '/sitemap.xml') {
    const body = (await readFile(join(root, 'sitemap.xml'), 'utf8')).replaceAll('{{ORIGIN}}', origin);
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' }).end(body);
    return;
  }
  const file = staticFiles[path];
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': types[ext] }).end(await readFile(join(root, file)));
}).listen(port, () => console.log(`visual-page fixture on http://localhost:${port}`));
