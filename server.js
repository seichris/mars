#!/usr/bin/env node

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT ?? process.argv[2] ?? 8000);
const ROOT = __dirname;
const KML_PATH = path.join(ROOT, "MarsTopo7mRelief.kml");
const LOG_TILES = ["1", "true", "yes"].includes(String(process.env.LOG_TILES ?? "").toLowerCase());
const LOG_REQUESTS = ["1", "true", "yes"].includes(
  String(process.env.LOG_REQUESTS ?? "").toLowerCase(),
);

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".kml":
      return "application/vnd.google-earth.kml+xml; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function resolveUpstreamTileHost() {
  const fallback = "https://pub-3c6ee3900f804513bd3b2a3e4df337bd.r2.dev";
  try {
    const text = await fs.readFile(KML_PATH, "utf8");
    const hrefMatch = text.match(/<href>\s*([^<]+\/0\/0\/0\.kml)\s*<\/href>/i);
    if (!hrefMatch) return fallback;
    return hrefMatch[1].replace(/\/0\/0\/0\.kml$/i, "");
  } catch {
    return fallback;
  }
}

function safeJoin(root, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const filePath = path.normalize(path.join(root, decoded));
  if (!filePath.startsWith(root)) return null;
  return filePath;
}

function proxyRequest(upstreamUrl, clientReq, clientRes) {
  const url = new URL(upstreamUrl);
  const lib = url.protocol === "https:" ? https : http;

  const upstreamReq = lib.request(
    url,
    {
      method: clientReq.method,
      headers: {
        "user-agent": "view-mars proxy",
        accept: clientReq.headers.accept ?? "*/*",
      },
    },
    (upstreamRes) => {
      if (LOG_TILES) {
        // eslint-disable-next-line no-console
        console.log(
          `[tiles] ${clientReq.method} ${clientReq.url} -> ${upstreamRes.statusCode ?? "?"}`,
        );
      }
      clientRes.statusCode = upstreamRes.statusCode ?? 502;
      if (upstreamRes.headers["content-type"]) {
        clientRes.setHeader("content-type", upstreamRes.headers["content-type"]);
      }
      if (upstreamRes.headers["content-length"]) {
        clientRes.setHeader("content-length", upstreamRes.headers["content-length"]);
      }
      if (upstreamRes.headers.etag) {
        clientRes.setHeader("etag", upstreamRes.headers.etag);
      }
      if (upstreamRes.headers["last-modified"]) {
        clientRes.setHeader("last-modified", upstreamRes.headers["last-modified"]);
      }
      clientRes.setHeader("cache-control", "public, max-age=86400");

      if (clientReq.method === "HEAD") {
        upstreamRes.resume();
        clientRes.end();
        return;
      }

      upstreamRes.pipe(clientRes);
    },
  );

  upstreamReq.on("error", () => {
    if (LOG_TILES) {
      // eslint-disable-next-line no-console
      console.log(`[tiles] ${clientReq.method} ${clientReq.url} -> error`);
    }
    clientRes.statusCode = 502;
    clientRes.setHeader("content-type", "text/plain; charset=utf-8");
    clientRes.end("Upstream tile fetch failed");
  });

  upstreamReq.end();
}

resolveUpstreamTileHost().then((upstreamTileHost) => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/tiles/")) {
      const upstreamUrl = `${upstreamTileHost}${url.pathname.replace(/^\/tiles/, "")}${url.search}`;
      proxyRequest(upstreamUrl, req, res);
      return;
    }

    if (LOG_REQUESTS) {
      // eslint-disable-next-line no-console
      console.log(`[static] ${req.method} ${url.pathname}`);
    }

    const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = safeJoin(ROOT, requestPath);
    if (!filePath) {
      res.statusCode = 400;
      res.end("Bad request");
      return;
    }

    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", contentType(filePath));
      res.setHeader("cache-control", "no-cache");
      res.setHeader("x-upstream-tile-host", upstreamTileHost);

      if (req.method === "HEAD") {
        res.end();
        return;
      }

      const data = await fs.readFile(filePath);
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  });

  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`view-mars running on http://localhost:${PORT}/`);
  });
});
