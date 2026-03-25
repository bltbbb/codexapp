import http from 'node:http';
import net from 'node:net';

const LISTEN_HOST = process.env.HAPI_PROXY_HOST || '0.0.0.0';
const LISTEN_PORT = Number(process.env.HAPI_PROXY_PORT || 4633);
const TARGET_HOST = process.env.HAPI_TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.HAPI_TARGET_PORT || 3006);

const server = http.createServer((req, res) => {
  const options = {
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: {
      ...req.headers,
      host: `${TARGET_HOST}:${TARGET_PORT}`,
      connection: req.headers.upgrade ? 'Upgrade' : (req.headers.connection || 'keep-alive'),
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end(`HAPI 代理请求失败：${error.message}`);
  });

  req.pipe(proxyReq);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\r\n');

    upstream.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`,
    );

    if (head && head.length) {
      upstream.write(head);
    }

    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  const closeBoth = () => {
    socket.destroy();
    upstream.destroy();
  };

  upstream.on('error', closeBoth);
  socket.on('error', closeBoth);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`[hapi-proxy] listening on http://${LISTEN_HOST}:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT}`);
});
