// Isolated test harness only. Production file delivery uses stdio MCP and
// host-owned paths, not this HTTP server.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DocumentStore } from './document-store.mjs';

export async function startPreview(sourcePath) {
  const store = new DocumentStore();
  await store.describe(sourcePath);
  const token = randomBytes(24).toString('hex');
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; worker-src blob:; connect-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== new URL(origin).host) { res.writeHead(403).end(); return; }
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && [`/${token}/`,`/${token}/host`,`/${token}/plugin-app`].includes(url.pathname)) {
      const shell = await readFile(new URL(url.pathname.endsWith('/host')?'./dist/host-harness.html':'./dist/ui.html', import.meta.url), 'utf8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(shell.replace('<head>', `<head><meta name="local-preview-token" content="${token}">`));
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/api/tool' || req.headers.origin !== origin ||
        req.headers['content-type'] !== 'application/json') { res.writeHead(403).end(); return; }
    const auth = Buffer.from(String(req.headers['x-preview-token'] ?? ''));
    const secret = Buffer.from(token);
    if (auth.length !== secret.length || !timingSafeEqual(auth, secret)) { res.writeHead(403).end(); return; }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) throw new Error('Request too large.');
      }
      const request = JSON.parse(body);
      const args = request.arguments ?? {};
      let result;
      switch (request.name) {
        case 'pdf_info': result = await store.describe(sourcePath); break;
        case 'pdf_read': result = await store.read(sourcePath, args); break;
        case 'pdf_asset': result = await store.asset(args); break;
        default: throw new Error('Unknown preview operation.');
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ content: [], structuredContent: result }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Preview operation failed.' }] }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: `${origin}/${token}/?preview=1` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Specify the local PDF to test.');
  const { url } = await startPreview(process.argv[2]);
  // URL is a temporary loopback-only test capability, not an account credential.
  process.stdout.write(JSON.stringify({ previewUrl: url }) + '\n');
}
