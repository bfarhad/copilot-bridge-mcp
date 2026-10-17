#!/usr/bin/env node
// Edge's DevTools endpoint rejects requests whose Host header isn't an IP or
// localhost, which is what the container sends (host.docker.internal).
// By default it listens on loopback only (OrbStack routes host.docker.internal to
// the host's loopback). On runtimes where the container cannot reach host loopback,
// set CDP_PROXY_HOST to the Docker bridge address — never 0.0.0.0 on an untrusted
// network, since this port gives full control of the browser.
// It rewrites the Host header and the ws:// URLs in replies.
import http from "node:http";
import net from "node:net";

const TARGET_PORT = Number(process.env.CDP_PORT ?? 9222);
const LISTEN_PORT = Number(process.env.CDP_PROXY_PORT ?? 9223);
const LISTEN_HOST = process.env.CDP_PROXY_HOST ?? "127.0.0.1";
const TARGET_HOST = `127.0.0.1:${TARGET_PORT}`;

const server = http.createServer((req, res) => {
  const origHost = req.headers.host ?? `localhost:${LISTEN_PORT}`;
  const up = http.request(
    { host: "127.0.0.1", port: TARGET_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: TARGET_HOST } },
    (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const body = Buffer.from(Buffer.concat(chunks).toString().replaceAll(TARGET_HOST, origHost));
        const headers = { ...r.headers, "content-length": body.length };
        res.writeHead(r.statusCode ?? 502, headers);
        res.end(body);
      });
    }
  );
  up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  const up = net.connect(TARGET_PORT, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      lines.push(`${k}: ${k.toLowerCase() === "host" ? TARGET_HOST : req.rawHeaders[i + 1]}`);
    }
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(LISTEN_PORT, LISTEN_HOST, () =>
  console.log(`CDP proxy ${LISTEN_HOST}:${LISTEN_PORT} → ${TARGET_HOST}`)
);
