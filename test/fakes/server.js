// Generic fake HTTP server for the tests: no real network call is ever made.

import { createServer } from 'node:http';

/**
 * Starts a server on a random local port. `handler(req, body)` returns
 * { status, headers, body } (body: string | object) or undefined for 404.
 */
export async function startFake(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      // keep the raw text
    }
    const url = new URL(req.url, 'http://fake');
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const reply = (await handler({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body })) ?? {
      status: 404,
      body: { message: 'Not Found' },
    };
    const isText = typeof reply.body === 'string';
    res.writeHead(reply.status ?? 200, {
      'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json',
      ...reply.headers,
    });
    res.end(isText ? reply.body : JSON.stringify(reply.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}
