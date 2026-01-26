/* global Cesium */

// KML points at a KML super-overlay. Cesium's KML NetworkLink/Region support is limited,
// so we load the underlying tile JPGs directly as an imagery layer.
const KML_DESCRIPTOR_PATH = "./MarsTopo7mRelief.kml";
const PROXY_BASE_PATH = "./tiles";
const debug = new URLSearchParams(window.location.search).has("debug");

async function resolveTileHostFromKmlDescriptor() {
  try {
    const resp = await fetch(KML_DESCRIPTOR_PATH);
    if (!resp.ok) return null;
    const text = await resp.text();

    const hrefMatch = text.match(/<href>\s*([^<]+\/0\/0\/0\.kml)\s*<\/href>/i);
    if (!hrefMatch) return null;

    return hrefMatch[1].replace(/\/0\/0\/0\.kml$/i, "");
  } catch {
    return null;
  }
}

(async () => {
  const tileHostFallback = "https://pub-3c6ee3900f804513bd3b2a3e4df337bd.r2.dev";
  const tileHost = (await resolveTileHostFromKmlDescriptor()) ?? tileHostFallback;
  document.getElementById("tileHost").textContent = tileHost;
  const statusEl = document.getElementById("status");

  const proxyAvailable = await fetch(`${PROXY_BASE_PATH}/0/0/0.jpg`, { method: "HEAD" })
    .then((r) => r.ok)
    .catch(() => false);

  const imageryBaseUrl = proxyAvailable ? PROXY_BASE_PATH : tileHost;
  if (proxyAvailable) {
    statusEl.textContent = "Using local tile proxy (/tiles).";
  } else {
    statusEl.textContent =
      "Tile proxy not found. For this dataset, start the bundled proxy: `node server.js`.";
  }

  if (debug) {
    // eslint-disable-next-line no-console
    console.log("[view-mars] tile host:", tileHost);
    // eslint-disable-next-line no-console
    console.log("[view-mars] imagery base:", imageryBaseUrl);
  }

  const sampleTileUrl = `${imageryBaseUrl}/0/0/0.jpg`;
  const sampleCheck = await fetch(sampleTileUrl, { method: "HEAD" })
    .then((r) => r)
    .catch(() => null);

  if (!sampleCheck?.ok) {
    statusEl.textContent = `Sample tile check failed (${sampleCheck?.status ?? "network error"}).`;
  }

  if (debug) {
    // eslint-disable-next-line no-console
    console.log(
      "[view-mars] sample tile:",
      sampleTileUrl,
      "status:",
      sampleCheck?.status ?? "error",
      "content-type:",
      sampleCheck?.headers?.get("content-type") ?? "n/a",
    );
  }

  const marsEllipsoid = new Cesium.Ellipsoid(3396190.0, 3396190.0, 3376200.0);

  // Custom scheme matching this dataset’s KML super-overlay pyramid.
  // Tile counts per zoom are *not* purely power-of-two at low zooms:
  // z=0: 1x1, z=1: 4x2, z=2: 12x6, z=3: 36x18, z=4: 180x90, z>=5 doubles each level.
  const tilingScheme = (() => {
    const rectangle = Cesium.Rectangle.fromDegrees(-180, -90, 180, 90);
    const projection = new Cesium.GeographicProjection(marsEllipsoid);

    function tilesX(level) {
      if (level <= 0) return 1;
      if (level === 1) return 4;
      if (level === 2) return 12;
      if (level === 3) return 36;
      if (level === 4) return 180;
      return 360 * 2 ** (level - 5);
    }

    function tilesY(level) {
      if (level <= 0) return 1;
      if (level === 1) return 2;
      if (level === 2) return 6;
      if (level === 3) return 18;
      if (level === 4) return 90;
      return 180 * 2 ** (level - 5);
    }

    function tileXYToRectangle(x, y, level, result) {
      const xTiles = tilesX(level);
      const yTiles = tilesY(level);

      const lonWidth = (rectangle.east - rectangle.west) / xTiles;
      const latHeight = (rectangle.north - rectangle.south) / yTiles;

      const west = rectangle.west + x * lonWidth;
      const east = rectangle.west + (x + 1) * lonWidth;
      const north = rectangle.north - y * latHeight;
      const south = rectangle.north - (y + 1) * latHeight;

      if (result) {
        result.west = west;
        result.south = south;
        result.east = east;
        result.north = north;
        return result;
      }

      return new Cesium.Rectangle(west, south, east, north);
    }

    function positionToTileXY(position, level, result) {
      const xTiles = tilesX(level);
      const yTiles = tilesY(level);

      const xFraction = (position.longitude - rectangle.west) / (rectangle.east - rectangle.west);
      const yFraction = (rectangle.north - position.latitude) / (rectangle.north - rectangle.south);

      let x = Math.floor(xFraction * xTiles);
      let y = Math.floor(yFraction * yTiles);

      x = Math.min(Math.max(x, 0), xTiles - 1);
      y = Math.min(Math.max(y, 0), yTiles - 1);

      if (result) {
        result.x = x;
        result.y = y;
        return result;
      }

      return new Cesium.Cartesian2(x, y);
    }

    return {
      ellipsoid: marsEllipsoid,
      rectangle,
      projection,
      getNumberOfXTilesAtLevel: tilesX,
      getNumberOfYTilesAtLevel: tilesY,
      tileXYToRectangle,
      tileXYToNativeRectangle: tileXYToRectangle,
      positionToTileXY,
    };
  })();

  const imageryProvider = new Cesium.UrlTemplateImageryProvider({
    url: `${imageryBaseUrl}/{z}/{x}/{y}.jpg`,
    tilingScheme,
    rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90),
    minimumLevel: 0,
    maximumLevel: 10,
  });

  const baseLayer = new Cesium.ImageryLayer(imageryProvider);

  const readyPromise = imageryProvider.readyPromise;
  if (readyPromise && typeof readyPromise.then === "function") {
    readyPromise
      .then(() => {
        if (debug) {
          // eslint-disable-next-line no-console
          console.log("[view-mars] imagery provider ready", {
            tileWidth: imageryProvider.tileWidth,
            tileHeight: imageryProvider.tileHeight,
            minimumLevel: imageryProvider.minimumLevel,
            maximumLevel: imageryProvider.maximumLevel,
          });
        }
      })
      .catch((err) => {
        statusEl.textContent = "Imagery provider failed to initialize. Check console.";
        // eslint-disable-next-line no-console
        console.error("[view-mars] imagery provider error:", err);
      });
  } else if (debug) {
    // eslint-disable-next-line no-console
    console.log("[view-mars] imagery provider ready (sync)", {
      tileWidth: imageryProvider.tileWidth,
      tileHeight: imageryProvider.tileHeight,
      minimumLevel: imageryProvider.minimumLevel,
      maximumLevel: imageryProvider.maximumLevel,
    });
  }

  if (debug) {
    const originalRequestImage = imageryProvider.requestImage?.bind(imageryProvider);
    if (originalRequestImage) {
      imageryProvider.requestImage = (x, y, level, request) => {
        // eslint-disable-next-line no-console
        console.log("[view-mars] requestImage", {
          level,
          x,
          y,
          url: `${imageryBaseUrl}/${level}/${x}/${y}.jpg`,
        });
        return originalRequestImage(x, y, level, request);
      };
    }
  }

  imageryProvider.errorEvent.addEventListener((err) => {
    statusEl.textContent = "Imagery error while loading tiles. Check console for details.";
    // eslint-disable-next-line no-console
    console.error("[view-mars] imagery error:", err);
  });

  const viewer = new Cesium.Viewer("cesiumContainer", {
    baseLayer,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    timeline: false,
    animation: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    vrButton: false,
    shouldAnimate: false,
  });

  if (debug) {
    // eslint-disable-next-line no-console
    console.log("[view-mars] imagery layers:", viewer.imageryLayers.length);
    // eslint-disable-next-line no-console
    console.log(
      "[view-mars] base layer provider:",
      baseLayer?.imageryProvider?.constructor?.name ?? "none",
    );
    window.viewer = viewer;
    window.imageryProvider = imageryProvider;
    window.baseLayer = baseLayer;
  }

  viewer.scene.globe.ellipsoid = marsEllipsoid;
  viewer.scene.globe.enableLighting = false;
  viewer.scene.globe.showGroundAtmosphere = false;
  viewer.scene.skyAtmosphere.show = false;
  viewer.scene.skyBox.show = false;
  viewer.scene.sun.show = false;
  viewer.scene.moon.show = false;
  viewer.scene.backgroundColor = Cesium.Color.BLACK;

  if (debug) {
    viewer.scene.globe.tileLoadProgressEvent.addEventListener((count) => {
      // eslint-disable-next-line no-console
      console.log("[view-mars] tiles loading:", count);
    });
  }

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(0, 0, marsEllipsoid.maximumRadius * 4.0, marsEllipsoid),
    orientation: {
      heading: 0.0,
      pitch: -Cesium.Math.PI_OVER_TWO,
      roll: 0.0,
    },
  });
})();
