#!/usr/bin/env node

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT ?? process.argv[2] ?? 8000);
const ROOT = __dirname;
const KML_PATH = path.join(ROOT, "assets", "MarsTopo7mRelief.kml");
const ENV_PATH = path.join(ROOT, ".env");
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

async function loadEnvFromFile() {
  try {
    const raw = await fs.readFile(ENV_PATH, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (!key) continue;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // ignore missing .env
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

/**
 * Proxy S3 requests with AWS Signature V4 authentication
 * Supports range requests for COG streaming
 */
function proxyS3Request(s3Key, clientReq, clientRes) {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const addressingStyle = process.env.S3_ADDRESSING_STYLE || "path";

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    clientRes.statusCode = 500;
    clientRes.setHeader("content-type", "text/plain");
    clientRes.end("S3 not configured");
    return;
  }

  const url = new URL(endpoint);
  if (addressingStyle === "virtual") {
    url.hostname = `${bucket}.${url.hostname}`;
    url.pathname = `/${s3Key}`;
  } else {
    url.pathname = `/${bucket}/${s3Key}`;
  }

  const lib = url.protocol === "https:" ? https : http;
  const method = clientReq.method || "GET";
  const date = new Date().toUTCString();

  // Simple S3 authentication (works for MinIO)
  const headers = {
    Host: url.host,
    Date: date,
    "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
  };

  // Forward range header for COG streaming
  if (clientReq.headers.range) {
    headers.Range = clientReq.headers.range;
  }

  // Create AWS Signature V4 (simplified for MinIO compatibility)
  const crypto = require("crypto");
  const region = "us-east-1"; // MinIO typically uses this
  const service = "s3";
  const amzDate = headers["x-amz-date"];
  const dateStamp = amzDate.substring(0, 8);

  const canonicalUri = url.pathname;
  const canonicalQueryString = "";
  const signedHeaders = "host;x-amz-date";
  const payloadHash = crypto.createHash("sha256").update("").digest("hex");

  const canonicalHeaders = `host:${url.host}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;

  function hmacSha256(key, data) {
    return crypto.createHmac("sha256", key).update(data).digest();
  }

  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  headers.Authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const upstreamReq = lib.request(
    url,
    { method, headers },
    (upstreamRes) => {
      clientRes.statusCode = upstreamRes.statusCode ?? 502;

      // Forward relevant headers
      const forwardHeaders = [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
      ];
      for (const h of forwardHeaders) {
        if (upstreamRes.headers[h]) {
          clientRes.setHeader(h, upstreamRes.headers[h]);
        }
      }

      // Enable CORS for browser access
      clientRes.setHeader("access-control-allow-origin", "*");
      clientRes.setHeader("access-control-allow-headers", "Range");
      clientRes.setHeader("access-control-expose-headers", "Content-Range, Accept-Ranges, Content-Length");
      clientRes.setHeader("cache-control", "public, max-age=86400");

      if (clientReq.method === "HEAD" || clientReq.method === "OPTIONS") {
        upstreamRes.resume();
        clientRes.end();
        return;
      }

      upstreamRes.pipe(clientRes);
    }
  );

  upstreamReq.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[s3-proxy] error:", err.message);
    clientRes.statusCode = 502;
    clientRes.setHeader("content-type", "text/plain");
    clientRes.end("S3 fetch failed");
  });

  upstreamReq.end();
}

loadEnvFromFile().then(() => {
  resolveUpstreamTileHost().then((upstreamTileHost) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/config.js") {
        const token = process.env.CESIUM_TOKEN ?? "";
        const terrainAssetId =
          process.env.CESIUM_MARS_TERRAIN_ASSET_ID ??
          process.env.CESIUM_TERRAIN_ASSET_ID ??
          "";
        res.statusCode = 200;
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.setHeader("cache-control", "no-cache");
        res.end(
          `window.__CESIUM_ION_TOKEN = ${JSON.stringify(token)};` +
          `window.__CESIUM_TERRAIN_ASSET_ID = ${JSON.stringify(terrainAssetId)};`,
        );
        return;
      }

      if (url.pathname === "/map/") {
        res.statusCode = 302;
        res.setHeader("location", "/map");
        res.end();
        return;
      }

      if (url.pathname.startsWith("/tiles/")) {
        const upstreamUrl = `${upstreamTileHost}${url.pathname.replace(/^\/tiles/, "")}${url.search}`;
        proxyRequest(upstreamUrl, req, res);
        return;
      }

      // COG terrain proxy - streams from S3 with range request support
      if (url.pathname === "/terrain/cog" || url.pathname === "/terrain/cog.tif") {
        // Handle CORS preflight
        if (req.method === "OPTIONS") {
          res.statusCode = 200;
          res.setHeader("access-control-allow-origin", "*");
          res.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
          res.setHeader("access-control-allow-headers", "Range");
          res.setHeader("access-control-max-age", "86400");
          res.end();
          return;
        }
        proxyS3Request("mars_valles_tharsis_cog.tif", req, res);
        return;
      }

      if (LOG_REQUESTS) {
        // eslint-disable-next-line no-console
        console.log(`[static] ${req.method} ${url.pathname}`);
      }

      let requestPath = url.pathname;
      if (requestPath === "/") {
        requestPath = "/drive.html";
      } else if (requestPath === "/map" || requestPath === "/map/") {
        requestPath = "/index.html";
      }
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
});
