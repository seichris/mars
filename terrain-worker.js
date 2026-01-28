import * as GeoTIFF from "https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm";

const COG_ORIGIN_LON = 180;
const COG_ORIGIN_LAT = 55;
const COG_PIXEL_SIZE_LON = 0.003374135377809;
const COG_PIXEL_SIZE_LAT = -0.003374129627926;

let cogUrl = "/terrain/cog";
let cogTiff = null;
let cogImage = null;
let cogWidth = 0;
let cogHeight = 0;
let cogLoading = null;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function latLonToPixelF(lat, lon) {
  let normLon = lon;
  if (normLon < 0) normLon += 360;
  if (normLon < 180) normLon += 180;
  const pixelX = (normLon - COG_ORIGIN_LON) / COG_PIXEL_SIZE_LON;
  const pixelY = (lat - COG_ORIGIN_LAT) / COG_PIXEL_SIZE_LAT;
  return { x: pixelX, y: pixelY };
}

async function ensureCog() {
  if (cogImage) return;
  if (!cogLoading) {
    cogLoading = (async () => {
      cogTiff = await GeoTIFF.fromUrl(cogUrl, { allowFullFile: false });
      cogImage = await cogTiff.getImage();
      cogWidth = cogImage.getWidth();
      cogHeight = cogImage.getHeight();
    })();
  }
  await cogLoading;
}

async function sampleHeightGrid(bounds, segments) {
  if (!cogImage) return null;
  const { south, north, west, east } = bounds;
  const rows = segments + 1;
  const cols = segments + 1;

  const pNW = latLonToPixelF(north, west);
  const pNE = latLonToPixelF(north, east);
  const pSW = latLonToPixelF(south, west);
  const pSE = latLonToPixelF(south, east);
  const minX = clamp(Math.floor(Math.min(pNW.x, pNE.x, pSW.x, pSE.x)), 0, cogWidth - 1);
  const maxX = clamp(Math.ceil(Math.max(pNW.x, pNE.x, pSW.x, pSE.x)), 0, cogWidth - 1);
  const minY = clamp(Math.floor(Math.min(pNW.y, pNE.y, pSW.y, pSE.y)), 0, cogHeight - 1);
  const maxY = clamp(Math.ceil(Math.max(pNW.y, pNE.y, pSW.y, pSE.y)), 0, cogHeight - 1);

  const raster = await cogImage.readRasters({
    window: [minX, minY, maxX + 1, maxY + 1],
  });

  const rasterData = raster[0];
  const rasterWidth = maxX - minX + 1;
  const rasterHeight = maxY - minY + 1;

  const heightAt = (x, y) => {
    const idx = y * rasterWidth + x;
    const h = rasterData[idx];
    return h === undefined || h <= -32000 ? 0 : h;
  };

  const sampleBilinearFromWindow = (px, py) => {
    const x = clamp(px, minX, maxX) - minX;
    const y = clamp(py, minY, maxY) - minY;
    const x0 = clamp(Math.floor(x), 0, rasterWidth - 1);
    const y0 = clamp(Math.floor(y), 0, rasterHeight - 1);
    const x1 = Math.min(x0 + 1, rasterWidth - 1);
    const y1 = Math.min(y0 + 1, rasterHeight - 1);
    const sx = x - x0;
    const sy = y - y0;
    const h00 = heightAt(x0, y0);
    const h10 = heightAt(x1, y0);
    const h01 = heightAt(x0, y1);
    const h11 = heightAt(x1, y1);
    const hx0 = h00 + (h10 - h00) * sx;
    const hx1 = h01 + (h11 - h01) * sx;
    return hx0 + (hx1 - hx0) * sy;
  };

  const heights = new Float32Array(rows * cols);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const lat = north + (south - north) * (row / segments);
      const lon = west + (east - west) * (col / segments);
      const p = latLonToPixelF(lat, lon);
      heights[row * cols + col] = sampleBilinearFromWindow(p.x, p.y);
    }
  }
  return heights;
}

self.onmessage = async (event) => {
  const { type } = event.data ?? {};
  if (type === "init") {
    if (event.data?.url) cogUrl = event.data.url;
    try {
      await ensureCog();
      self.postMessage({ type: "ready", width: cogWidth, height: cogHeight });
    } catch (err) {
      self.postMessage({ type: "ready", error: err?.message ?? String(err) });
    }
    return;
  }
  if (type === "sampleGrid") {
    const { id, bounds, segments } = event.data;
    try {
      await ensureCog();
      const heights = await sampleHeightGrid(bounds, segments);
      const buffer = heights ? heights.buffer : null;
      if (buffer) {
        self.postMessage({ type: "sampleGridResult", id, heights: buffer }, [buffer]);
      } else {
        self.postMessage({ type: "sampleGridResult", id, heights: null });
      }
    } catch (err) {
      self.postMessage({ type: "sampleGridError", id, message: err?.message ?? String(err) });
    }
  }
};
