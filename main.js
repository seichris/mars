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
		terrainProvider: new Cesium.EllipsoidTerrainProvider(),
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
	imageryViewer.scene.skyAtmosphere.show = false;
	imageryViewer.scene.skyBox.show = false;
	imageryViewer.scene.sun.show = false;
	imageryViewer.scene.moon.show = false;
	imageryViewer.scene.backgroundColor = Cesium.Color.BLACK;

	// Optional: Enable DEM terrain from Cesium ion
	const toggleIonMarsEl = document.getElementById("toggleIonMars");
	const ionMarsStateEl = document.getElementById("ionMarsState");
	const ionMarsHintEl = document.getElementById("ionMarsHint");
	let ionMarsEnabled = false;
	const serverToken = (window.__CESIUM_ION_TOKEN ?? "").trim();
	// User's uploaded DEM terrain asset
	const ION_TERRAIN_ASSET_ID = 4384856;
	let originalTerrainProvider = null;
	if (serverToken) {
		Cesium.Ion.defaultAccessToken = serverToken;
	}

	function setIonMarsUi(enabled) {
		ionMarsEnabled = enabled;
		if (ionMarsStateEl) {
			ionMarsStateEl.textContent = enabled ? "on" : "off";
			ionMarsStateEl.classList.toggle("on", enabled);
		}
	}

	async function ensureIonToken() {
		if (serverToken) return serverToken;
		const existing = (localStorage.getItem("CESIUM_ION_TOKEN") ?? "").trim();
		if (existing) return existing;
		const entered = (window.prompt("Enter Cesium ion access token (will be saved in localStorage):") ?? "")
			.trim();
		if (!entered) return null;
		localStorage.setItem("CESIUM_ION_TOKEN", entered);
		return entered;
	}

	function describeIonError(err) {
		if (!err) return "Unknown error.";
		if (err.message) return err.message;
		if (err.statusCode) return `HTTP ${err.statusCode}`;
		if (err.response?.statusCode) return `HTTP ${err.response.statusCode}`;
		return String(err);
	}

	async function enableIonMars() {
		const token = await ensureIonToken();
		if (!token) {
			if (ionMarsHintEl) ionMarsHintEl.textContent = "No token provided. Terrain remains off.";
			return;
		}

		Cesium.Ion.defaultAccessToken = token;
		if (ionMarsHintEl) ionMarsHintEl.textContent = "Loading DEM terrain from ion…";
		statusEl.textContent = "Loading DEM terrain (ion)…";

		try {
			// Save the original terrain provider so we can restore it later
			if (!originalTerrainProvider) {
				originalTerrainProvider = imageryViewer.terrainProvider;
			}

			// Load the user's DEM terrain from Cesium ion
			const terrainProvider = await Cesium.CesiumTerrainProvider.fromIonAssetId(ION_TERRAIN_ASSET_ID);

			// Debug: Log terrain provider details
			// eslint-disable-next-line no-console
			console.log("[view-mars] Terrain provider loaded:", {
				assetId: ION_TERRAIN_ASSET_ID,
				ready: terrainProvider.ready,
				hasWaterMask: terrainProvider.hasWaterMask,
				hasVertexNormals: terrainProvider.hasVertexNormals,
				tilingScheme: terrainProvider.tilingScheme?.constructor?.name,
				ellipsoid: terrainProvider.tilingScheme?.ellipsoid?.radii,
				availability: terrainProvider.availability ? "yes" : "no",
			});

			// Replace the terrain provider - Handmer imagery will automatically drape over it
			imageryViewer.terrainProvider = terrainProvider;

			// Enable terrain exaggeration to make it more visible (optional)
			imageryViewer.scene.verticalExaggeration = 1.0; // Set to 2.0 or higher to exaggerate

			// Make sure the globe is using terrain
			imageryViewer.scene.globe.depthTestAgainstTerrain = true;

			setIonMarsUi(true);
			statusEl.textContent = "DEM terrain enabled (ion).";
			if (ionMarsHintEl) {
				ionMarsHintEl.textContent = "DEM terrain enabled. Zoom in and tilt to see relief with Handmer imagery.";
			}

			// eslint-disable-next-line no-console
			console.log("[view-mars] DEM terrain provider loaded from asset", ION_TERRAIN_ASSET_ID);

			// Test sample a height to verify terrain data is accessible
			try {
				const testPos = [Cesium.Cartographic.fromDegrees(-59.2, -13.74)]; // Near default spawn
				const sampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, testPos);
				// eslint-disable-next-line no-console
				console.log("[view-mars] Test height sample:", {
					lat: testPos[0].latitude * 180 / Math.PI,
					lon: testPos[0].longitude * 180 / Math.PI,
					height: sampled[0].height,
				});
			} catch (sampleErr) {
				// eslint-disable-next-line no-console
				console.warn("[view-mars] Test height sample failed:", sampleErr);
			}
		} catch (err) {
			setIonMarsUi(false);
			const message = describeIonError(err);
			statusEl.textContent = `Failed to load DEM terrain: ${message}`;
			// eslint-disable-next-line no-console
			console.error("[view-mars] terrain provider error:", err);
			if (ionMarsHintEl) ionMarsHintEl.textContent = `Failed to load: ${message}`;
		}
	}

	function disableIonMars() {
		// Restore the original ellipsoid terrain provider
		if (originalTerrainProvider) {
			imageryViewer.terrainProvider = originalTerrainProvider;
		}

		setIonMarsUi(false);
		statusEl.textContent = proxyAvailable ? "Using local tile proxy (/tiles)." : "Using remote tiles.";
		if (ionMarsHintEl) {
			ionMarsHintEl.textContent = serverToken
				? "Using CESIUM_TOKEN from server .env."
				: "Requires a Cesium ion access token.";
		}
	}

	if (toggleIonMarsEl) {
		toggleIonMarsEl.addEventListener("click", (e) => {
			e.preventDefault();
			if (ionMarsEnabled) disableIonMars();
			else enableIonMars();
		});
	}
	setIonMarsUi(false);
	if (ionMarsHintEl) {
		if (serverToken) ionMarsHintEl.textContent = "Using CESIUM_TOKEN from server .env.";
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

	const startView = {
		destination: Cesium.Cartesian3.fromDegrees(0, 0, marsEllipsoid.maximumRadius * 4.0, marsEllipsoid),
		orientation: {
			heading: 0.0,
			pitch: -Cesium.Math.PI_OVER_TWO,
			roll: 0.0,
		},
	};
	imageryViewer.camera.setView(startView);
})();
