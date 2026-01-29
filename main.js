/* global Cesium */

// KML points at a KML super-overlay. Cesium's KML NetworkLink/Region support is limited,
// so we load the underlying tile JPGs directly as an imagery layer.
const KML_DESCRIPTOR_PATH = "./assets/MarsTopo7mRelief.kml";
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

	const marsEllipsoid = Cesium.Ellipsoid.MARS ?? new Cesium.Ellipsoid(3396190.0, 3396190.0, 3376200.0);
	// Ensure Cesium uses Mars dimensions for all globe/3D-tiles math.
	// Cesium’s official "Cesium Mars" tileset expects this default.
	Cesium.Ellipsoid.default = marsEllipsoid;

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

	const imageryViewer = new Cesium.Viewer("cesiumContainer", {
		globe: new Cesium.Globe(marsEllipsoid),
		baseLayer,
		terrainProvider: new Cesium.EllipsoidTerrainProvider({ ellipsoid: marsEllipsoid }),
		contextOptions: {
			alpha: true,
		},
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
	imageryViewer.scene.screenSpaceCameraController.ellipsoid = marsEllipsoid;

	if (debug) {
		// eslint-disable-next-line no-console
		console.log("[view-mars] imagery layers:", imageryViewer.imageryLayers.length);
		// eslint-disable-next-line no-console
		console.log(
			"[view-mars] base layer provider:",
			baseLayer?.imageryProvider?.constructor?.name ?? "none",
		);
		window.viewer = imageryViewer;
		window.imageryProvider = imageryProvider;
		window.baseLayer = baseLayer;
	}

	imageryViewer.scene.globe.ellipsoid = marsEllipsoid;
	imageryViewer.scene.globe.enableLighting = false;
	imageryViewer.scene.globe.showGroundAtmosphere = false;
	imageryViewer.scene.globe.baseColor = Cesium.Color.fromBytes(30, 30, 30);
	imageryViewer.scene.skyAtmosphere.show = false;
	imageryViewer.scene.skyBox.show = false;
	imageryViewer.scene.sun.show = false;
	imageryViewer.scene.moon.show = false;
	imageryViewer.scene.backgroundColor = Cesium.Color.BLACK;

	// Optional: Enable DEM terrain from local COG (Valles Marineris region)
	const toggleDemTerrainEl = document.getElementById("toggleIonMars");
	const demTerrainStateEl = document.getElementById("ionMarsState");
	const demTerrainHintEl = document.getElementById("ionMarsHint");
	let demTerrainEnabled = false;
	let originalTerrainProvider = null;
	let demTerrainProvider = null;

	const DEM_TERRAIN_SEGMENTS = 32;
	const DEM_TERRAIN_WIDTH = DEM_TERRAIN_SEGMENTS + 1;
	const DEM_TERRAIN_HEIGHT = DEM_TERRAIN_SEGMENTS + 1;
	const DEM_TERRAIN_BOUNDS = {
		west: -180,
		east: 0,
		south: -55,
		north: 55,
	};
	const DEM_TERRAIN_EMPTY = new Float32Array(DEM_TERRAIN_WIDTH * DEM_TERRAIN_HEIGHT);

	let terrainWorker = null;
	let terrainWorkerReady = false;
	let terrainWorkerFailed = false;
	let terrainWorkerReadyPromise = null;
	let terrainWorkerReadyResolve = null;
	let terrainWorkerReqId = 1;
	const terrainWorkerRequests = new Map();

	function setDemTerrainUi(enabled) {
		demTerrainEnabled = enabled;
		if (demTerrainStateEl) {
			demTerrainStateEl.textContent = enabled ? "on" : "off";
			demTerrainStateEl.classList.toggle("on", enabled);
		}
	}

	function initTerrainWorker() {
		if (terrainWorker || terrainWorkerFailed) return;
		try {
			terrainWorker = new Worker(new URL("./terrain-worker.js", window.location.href), {
				type: "module",
			});
		} catch (err) {
			terrainWorkerFailed = true;
			// eslint-disable-next-line no-console
			console.warn("[view-mars] terrain worker init failed:", err);
			return;
		}
		terrainWorkerReadyPromise = new Promise((resolve) => {
			terrainWorkerReadyResolve = resolve;
		});
		terrainWorker.onmessage = (event) => {
			const { type } = event.data ?? {};
			if (type === "ready") {
				const { error } = event.data ?? {};
				terrainWorkerReady = !error;
				terrainWorkerFailed = Boolean(error);
				if (error) {
					// eslint-disable-next-line no-console
					console.warn("[view-mars] terrain worker ready error:", error);
				}
				if (terrainWorkerReadyResolve) {
					terrainWorkerReadyResolve(terrainWorkerReady);
					terrainWorkerReadyResolve = null;
				}
				return;
			}
			if (type === "sampleGridResult") {
				const { id, heights } = event.data;
				const entry = terrainWorkerRequests.get(id);
				if (!entry) return;
				terrainWorkerRequests.delete(id);
				const data = heights ? new Float32Array(heights) : null;
				entry.resolve(data);
				return;
			}
			if (type === "sampleGridError") {
				const { id, message } = event.data;
				const entry = terrainWorkerRequests.get(id);
				if (!entry) return;
				terrainWorkerRequests.delete(id);
				// eslint-disable-next-line no-console
				console.warn("[view-mars] terrain worker sample error:", message);
				entry.resolve(null);
			}
		};
		terrainWorker.onerror = (err) => {
			terrainWorkerFailed = true;
			if (terrainWorkerReadyResolve) {
				terrainWorkerReadyResolve(false);
				terrainWorkerReadyResolve = null;
			}
			// eslint-disable-next-line no-console
			console.warn("[view-mars] terrain worker error:", err);
		};
		terrainWorker.postMessage({ type: "init", url: "/terrain/cog" });
	}

	function ensureTerrainWorkerReady() {
		if (terrainWorkerReady) return Promise.resolve(true);
		initTerrainWorker();
		if (terrainWorkerFailed || !terrainWorker) return Promise.resolve(false);
		return terrainWorkerReadyPromise ?? Promise.resolve(false);
	}

	async function requestTerrainGrid(bounds) {
		const ready = await ensureTerrainWorkerReady();
		if (!ready || !terrainWorker) return null;
		const id = terrainWorkerReqId++;
		return new Promise((resolve) => {
			terrainWorkerRequests.set(id, { resolve });
			terrainWorker.postMessage({
				type: "sampleGrid",
				id,
				bounds,
				segments: DEM_TERRAIN_SEGMENTS,
			});
		});
	}

	function rectangleToBounds(rectangle) {
		return {
			west: Cesium.Math.toDegrees(rectangle.west),
			east: Cesium.Math.toDegrees(rectangle.east),
			south: Cesium.Math.toDegrees(rectangle.south),
			north: Cesium.Math.toDegrees(rectangle.north),
		};
	}

	function intersectsTerrain(bounds) {
		return !(
			bounds.east < DEM_TERRAIN_BOUNDS.west ||
			bounds.west > DEM_TERRAIN_BOUNDS.east ||
			bounds.north < DEM_TERRAIN_BOUNDS.south ||
			bounds.south > DEM_TERRAIN_BOUNDS.north
		);
	}

	function emptyHeightmap() {
		return new Float32Array(DEM_TERRAIN_EMPTY);
	}

	function getDemTerrainProvider() {
		if (demTerrainProvider) return demTerrainProvider;
		demTerrainProvider = new Cesium.CustomHeightmapTerrainProvider({
			width: DEM_TERRAIN_WIDTH,
			height: DEM_TERRAIN_HEIGHT,
			tilingScheme,
			callback: async (x, y, level) => {
				const rectangle = tilingScheme.tileXYToRectangle(x, y, level);
				const bounds = rectangleToBounds(rectangle);
				if (!intersectsTerrain(bounds)) {
					return emptyHeightmap();
				}
				const heights = await requestTerrainGrid(bounds);
				return heights ?? emptyHeightmap();
			},
		});
		return demTerrainProvider;
	}

	async function enableDemTerrain() {
		if (!originalTerrainProvider) {
			originalTerrainProvider = imageryViewer.terrainProvider;
		}
		if (demTerrainHintEl) demTerrainHintEl.textContent = "Loading DEM terrain from /terrain/cog...";
		statusEl.textContent = "Loading DEM terrain...";

		const ready = await ensureTerrainWorkerReady();
		if (!ready) {
			setDemTerrainUi(false);
			statusEl.textContent = "Terrain server unavailable.";
			if (demTerrainHintEl) demTerrainHintEl.textContent = "Terrain server unavailable.";
			return;
		}

		imageryViewer.terrainProvider = getDemTerrainProvider();
		imageryViewer.scene.verticalExaggeration = 1.0;
		imageryViewer.scene.globe.depthTestAgainstTerrain = true;

		setDemTerrainUi(true);
		statusEl.textContent = "DEM terrain enabled (COG).";
		if (demTerrainHintEl) {
			demTerrainHintEl.textContent =
				"DEM terrain enabled for Valles Marineris. Zoom in and tilt to see relief.";
		}
	}

	function disableDemTerrain() {
		if (originalTerrainProvider) {
			imageryViewer.terrainProvider = originalTerrainProvider;
		}

		setDemTerrainUi(false);
		statusEl.textContent = proxyAvailable ? "Using local tile proxy (/tiles)." : "Using remote tiles.";
		if (demTerrainHintEl) {
			demTerrainHintEl.textContent = "Terrain available around Valles Marineris. Click to enable.";
		}
	}

	if (toggleDemTerrainEl) {
		toggleDemTerrainEl.addEventListener("click", (e) => {
			e.preventDefault();
			if (demTerrainEnabled) disableDemTerrain();
			else enableDemTerrain();
		});
	}
	setDemTerrainUi(false);
	if (demTerrainHintEl) {
		demTerrainHintEl.textContent = "Terrain available around Valles Marineris. Click to enable.";
	}

	if (debug) {
		imageryViewer.scene.globe.tileLoadProgressEvent.addEventListener((count) => {
			// eslint-disable-next-line no-console
			console.log("[view-mars] tiles loading:", count);
		});
	}

	window.addEventListener("resize", () => {
		imageryViewer.resize();
	});

	const startTarget = Cesium.Cartesian3.fromDegrees(-60, -14, 0, marsEllipsoid);
	const startRange = 1800000;
	imageryViewer.camera.lookAt(
		startTarget,
		new Cesium.HeadingPitchRange(0.0, Cesium.Math.toRadians(-50), startRange),
	);
	imageryViewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

	if (debug) {
		const camCarto = Cesium.Cartographic.fromCartesian(
			imageryViewer.camera.position,
			marsEllipsoid,
		);
		// eslint-disable-next-line no-console
		console.log("[view-mars] camera height (m):", camCarto.height);
	}
})();
