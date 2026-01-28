import * as THREE from "three";
import { GLTFLoader } from "three/examples/loaders/GLTFLoader.js";
import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";
import * as CANNON from "cannon-es";
import CannonDebugger from "cannon-es-debugger";
import * as GeoTIFF from "geotiff";

const app = document.getElementById("app");
const statusEl = document.getElementById("status");
const speedEl = document.getElementById("speed");
const gearEl = document.getElementById("gear");
const coordsEl = document.getElementById("coords");
const inputEl = document.getElementById("input");
const zoomEl = document.getElementById("zoom");
const zoomValueEl = document.getElementById("zoomValue");
const sizeEl = document.getElementById("size");
const sizeValueEl = document.getElementById("sizeValue");
const hudEl = document.getElementById("hud");
const hudToggleEl = document.getElementById("hudToggle");
const ionTerrainToggleEl = document.getElementById("toggleIonTerrain");
const ionTerrainStateEl = document.getElementById("ionTerrainState");
const ionTerrainHintEl = document.getElementById("ionTerrainHint");
const terrainHeightEl = document.getElementById("terrainHeight");

const params = new URLSearchParams(window.location.search);
const debug = params.has("debug");
const debugPhysics = params.get("debugPhysics") === "1";
const debugTerrain = params.get("debugTerrain") === "1";
const debugImagery = params.get("debugImagery") === "1";
const debugMesh = params.get("debugMesh") === "1";
const debugSeams = params.get("debugSeams") === "1";
const debugHeights = params.get("debugHeights") === "1";
const terrainWorkerEnabled = params.get("terrainWorker") !== "0";
const forwardChunks = params.has("forwardChunks")
  ? params.get("forwardChunks") === "1"
  : true;
const logTerrain = debug || debugPhysics || debugTerrain;
const logImagery = debugImagery;
const logMesh = debugMesh || debugPhysics;
const logSeams = debugSeams;
const logHeights = debugHeights;
const freezeTiles = params.get("freezeTiles") === "1";
const noRenderHeights = params.get("noRenderHeights") === "1";
const noChunkEvict = true;
const numberParam = (key, fallback) => {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};
const PHYSICS_SCALE = 1;
const RENDER_SCALE = 100;
const WORLD_TO_RENDER = RENDER_SCALE / PHYSICS_SCALE;
const MARS_RADIUS = 3396190;
const TARGET_LENGTH = Number(params.get("length") ?? 4.5);
const TILE_LEVEL = Number(params.get("level") ?? 10);
const CENTER_LAT = Number(params.get("lat") ?? -13.74);
const CENTER_LON = Number(params.get("lon") ?? -59.2);
const SHOW_DEBUG_WHEELS = params.get("wheels") === "1";
const MODEL_YAW = (Number(params.get("yaw") ?? 90) * Math.PI) / 180;

const PROXY_BASE_PATH = "./tiles";
const CAR_ZIP_PATH = "./assets/cybertruck.zip";

const PHYSICS_FIXED_TIMESTEP = 1 / 60;
const PHYSICS_MAX_SUBSTEPS = 8;

const PHYSICS_TERRAIN_CHUNK_SIZE = Math.max(120, numberParam("pchunk", 2400)); // meters
const PHYSICS_TERRAIN_SEGMENTS = Math.max(2, Math.min(64, Math.round(numberParam("pseg", 2))));
const PHYSICS_TERRAIN_RADIUS = Math.max(0, Math.min(3, Math.round(numberParam("pradius", 1))));
const PHYSICS_CHUNK_FOV_DEG = Math.max(1, Math.min(180, numberParam("chunkFov", 150)));
const PHYSICS_CHUNK_ALWAYS_RADIUS = Math.max(
  0,
  Math.min(PHYSICS_TERRAIN_RADIUS, Math.round(numberParam("chunkAlways", 1))),
);
const PHYSICS_BUILD_PER_FRAME = Math.max(0, Math.round(numberParam("pbuildPerFrame", 1)));
const PHYSICS_BUILD_BUDGET_MS = Math.max(0, numberParam("pbuildMs", 1));
const PHYSICS_PREFETCH_EXTRA_RADIUS = Math.max(0, Math.round(numberParam("pprefetch", 0)));
const PHYSICS_PREFETCH_PER_FRAME = Math.max(0, Math.round(numberParam("pprefetchPerFrame", 1)));
const PHYSICS_PREFETCH_BUDGET_MS = Math.max(0, numberParam("pprefetchMs", 1));
const FLOATING_ORIGIN_THRESHOLD = Math.max(200, numberParam("origin", 1200)); // meters
const SAFETY_PLANE_MS = Math.max(0, numberParam("safetyPlaneMs", 0));
const PLANE_BLEND_MS = Math.max(0, numberParam("planeBlendMs", 250));
const PLANE_BLEND_MAX_DELTA = Math.max(0, numberParam("planeBlendMaxDelta", 50));

// ─────────────────────────────────────────────────────────────────────────────
// SIMPLE VEHICLE PHYSICS CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────

const TIRE_CONFIG = {
  rollingResistance: 0.012,   // Rolling resistance coefficient
};

const VEHICLE_CONFIG = {
  // Steering characteristics
  maxSteerAngle: 0.7,         // Max steering angle in radians (~40 degrees)
  steerSpeedReduction: 0.012, // Steering reduction per m/s of speed (reduced)
  minSteerMultiplier: 0.35,   // Minimum steering at high speed (35% of max)
  steerResponseRate: 6.0,     // How fast steering responds to input (faster)

  // Body dynamics
  angularDamping: 0.5,        // Increased for stability during turns
  linearDamping: 0.02,        // Minimal speed decay

  // Drive configuration
  driveType: "AWD",           // "FWD", "RWD", or "AWD"
  frontPowerBias: 0.5,        // For AWD: 50% front, 50% rear

  // Braking
  brakeBias: 0.6,             // 60% front brake bias
  maxBrakeForce: 100000,      // Maximum brake force (increased for harder braking)
};

// Lower the center of mass slightly by offsetting the chassis shape/mesh upward.
const COM_OFFSET_FACTOR = 0.1; // fraction of chassis height

function setStatus(message) {
  statusEl.textContent = message === "Ready" ? "" : message;
}

function terrainLog(message, data) {
  if (!logTerrain) return;
  console.log(`[drive] ${message}`, data);
}

function imageryLog(message, data) {
  if (!logImagery) return;
  console.log(`[drive] ${message}`, data);
}

function meshLog(message, data) {
  if (!logMesh) return;
  console.log(`[drive] ${message}`, data);
}

function seamLog(message, data) {
  if (!logSeams) return;
  console.log(`[drive] ${message}`, data);
}

function heightLog(message, data) {
  if (!logHeights) return;
  console.log(`[drive] ${message}`, data);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Calculate speed-dependent steering angle
 */
function getEffectiveSteerAngle(inputSteer, speed, config) {
  // Reduce steering angle at high speeds for stability
  const speedFactor = 1 - clamp(speed * config.steerSpeedReduction, 0, 1 - config.minSteerMultiplier);
  return inputSteer * config.maxSteerAngle * speedFactor;
}

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

function tileXYFromLatLon(level, lat, lon) {
  const xTiles = tilesX(level);
  const yTiles = tilesY(level);
  const x = clamp(Math.floor(((lon + 180) / 360) * xTiles), 0, xTiles - 1);
  const y = clamp(Math.floor(((90 - lat) / 180) * yTiles), 0, yTiles - 1);
  return { x, y };
}

function loadTexture(url, renderer) {
  const loader = new THREE.TextureLoader();
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        resolve(texture);
      },
      undefined,
      reject,
    );
  });
}

async function loadMarsTexture(renderer) {
  const { x, y } = tileXYFromLatLon(TILE_LEVEL, CENTER_LAT, CENTER_LON);
  const url = `${PROXY_BASE_PATH}/${TILE_LEVEL}/${x}/${y}.jpg`;
  const fallback = `${PROXY_BASE_PATH}/0/0/0.jpg`;

  try {
    const texture = await loadTexture(url, renderer);
    if (debug) console.log("[mars] texture", url);
    return texture;
  } catch {
    const texture = await loadTexture(fallback, renderer);
    if (debug) console.log("[mars] fallback texture", fallback);
    return texture;
  }
}

async function loadGltfFromZip(zipUrl) {
  const zipBuffer = await fetch(zipUrl).then((r) => r.arrayBuffer());
  const zip = await JSZip.loadAsync(zipBuffer);

  const entries = Object.values(zip.files).filter((file) => !file.dir);
  if (entries.length === 0) throw new Error("ZIP is empty");

  const gltfEntry = entries.find((file) => file.name.toLowerCase().endsWith(".gltf"));
  const glbEntry = entries.find((file) => file.name.toLowerCase().endsWith(".glb"));
  const mainEntry = gltfEntry ?? glbEntry;
  if (!mainEntry) throw new Error("No .gltf or .glb found in ZIP");

  const blobUrls = new Map();
  await Promise.all(
    entries.map(async (file) => {
      const blob = await file.async("blob");
      blobUrls.set(file.name, URL.createObjectURL(blob));
    }),
  );

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const cleaned = decodeURIComponent(url).replace(/^(\.\/)/, "");
    if (blobUrls.has(cleaned)) return blobUrls.get(cleaned);
    const fallback = cleaned.split("/").pop();
    if (fallback && blobUrls.has(fallback)) return blobUrls.get(fallback);
    return url;
  });

  const loader = new GLTFLoader(manager);
  const mainUrl = blobUrls.get(mainEntry.name);

  return new Promise((resolve, reject) => {
    loader.load(mainUrl, resolve, undefined, reject);
  });
}

function normalizeModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = (TARGET_LENGTH / maxDim) * RENDER_SCALE;

  model.scale.setScalar(scale);
  box.setFromObject(model);

  const center = new THREE.Vector3();
  box.getCenter(center);
  // Center the model so its bounding box is centered at the origin.
  model.position.sub(center);

  box.setFromObject(model);
  const finalSize = new THREE.Vector3();
  box.getSize(finalSize);

  return finalSize;
}

function buildVehicle(world, size, groundMaterial, massScale = 1) {
  const width = size.x;
  const height = size.y;
  const length = size.z;

  // Chassis centered on the model bounds so the collider wraps the mesh.
  const mainChassisExtents = new CANNON.Vec3(width * 0.5, height * 0.5, length * 0.5);
  const chassisShape = new CANNON.Box(mainChassisExtents);
  const comOffset = height * COM_OFFSET_FACTOR;
  const chassisBody = new CANNON.Body({
    mass: 3000 * massScale,
    material: new CANNON.Material("chassis"),
  });
  chassisBody.addShape(chassisShape, new CANNON.Vec3(0, comOffset, 0));
  const wheelRadius = Math.max(0.35, Math.min(width, length) * 0.12);
  const suspensionRest = Math.max(0.3, wheelRadius * 0.6);
  // Start slightly "compressed" so the wheel rays extend below the ground plane and register contact.
  const initialY = wheelRadius + height * 0.5 + suspensionRest * 0.4;
  chassisBody.position.set(0, initialY, 0);
  // Base damping values - will be scaled in setupVehicle
  chassisBody.angularDamping = 0.4;
  chassisBody.linearDamping = 0.2;

  const vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2,
  });

  const wheelMaterial = new CANNON.Material("wheel");
  const contact = new CANNON.ContactMaterial(
    wheelMaterial,
    groundMaterial,
    {
      friction: 0.6,
      restitution: 0,
      contactEquationStiffness: 1e6,
      contactEquationRelaxation: 3,
      frictionEquationStiffness: 1e7,
      frictionEquationRelaxation: 3,
    },
  );
  world.addContactMaterial(contact);

  const axle = width * 0.5;
  const frontZ = length * 0.35;
  const backZ = -length * 0.35;
  const connectionY = -height * 0.5;

  const wheelOptions = {
    radius: wheelRadius,
    directionLocal: new CANNON.Vec3(0, -1, 0),
    suspensionStiffness: 40,
    suspensionRestLength: suspensionRest,
    frictionSlip: 10,
    dampingRelaxation: 3.5,
    dampingCompression: 6.5,
    maxSuspensionForce: 100000,
    rollInfluence: 0.01,
    axleLocal: new CANNON.Vec3(1, 0, 0),
    chassisConnectionPointLocal: new CANNON.Vec3(0, 0, 0),
    maxSuspensionTravel: Math.max(0.3, wheelRadius * 0.5),
  };

  vehicle.addWheel({
    ...wheelOptions,
    chassisConnectionPointLocal: new CANNON.Vec3(-axle, connectionY, frontZ),
  });
  vehicle.addWheel({
    ...wheelOptions,
    chassisConnectionPointLocal: new CANNON.Vec3(axle, connectionY, frontZ),
  });
  vehicle.addWheel({
    ...wheelOptions,
    chassisConnectionPointLocal: new CANNON.Vec3(-axle, connectionY, backZ),
  });
  vehicle.addWheel({
    ...wheelOptions,
    chassisConnectionPointLocal: new CANNON.Vec3(axle, connectionY, backZ),
  });

  vehicle.addToWorld(world);

  return { vehicle, chassisBody, wheelRadius, initialY };
}

function createWheelMeshes(vehicle, wheelRadius) {
  const wheelMeshes = [];
  const geometry = new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelRadius * 0.6, 16);
  const material = new THREE.MeshStandardMaterial({ color: 0x1b1b1b });

  for (let i = 0; i < vehicle.wheelInfos.length; i += 1) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.z = Math.PI / 2;
    mesh.visible = SHOW_DEBUG_WHEELS;
    wheelMeshes.push(mesh);
  }

  return wheelMeshes;
}

function updateWheelMeshes(vehicle, wheelMeshes, scale) {
  for (let i = 0; i < vehicle.wheelInfos.length; i += 1) {
    vehicle.updateWheelTransform(i);
    const t = vehicle.wheelInfos[i].worldTransform;
    const mesh = wheelMeshes[i];
    mesh.position.set(t.position.x * scale, t.position.y * scale, t.position.z * scale);
    mesh.quaternion.copy(t.quaternion);
  }
}

async function main() {
  setStatus("Loading scene…");

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    logarithmicDepthBuffer: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x050505);
  app.appendChild(renderer.domElement);
  renderer.domElement.tabIndex = 0;
  renderer.domElement.addEventListener("pointerdown", () => renderer.domElement.focus());

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 10, 5000000);

  const ambient = new THREE.AmbientLight(0xffffff, 0.45);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(30, 80, 20);
  scene.add(sun);

  const tileGroup = new THREE.Group();
  scene.add(tileGroup);

  const metersPerDegLat = (2 * Math.PI * MARS_RADIUS) / 360;
  const metersPerDegLon = metersPerDegLat * Math.cos((CENTER_LAT * Math.PI) / 180);
  const worldOrigin = { x: 0, z: 0 };

  function chassisToLatLon(body, scale) {
    const worldX = worldOrigin.x + body.position.x * scale;
    const worldZ = worldOrigin.z + body.position.z * scale;
    const lat = CENTER_LAT - worldZ / metersPerDegLat;
    const lon = CENTER_LON + worldX / metersPerDegLon;
    return { lat, lon };
  }

  function latLonToChassis(lat, lon, scale) {
    const xMeters = (lon - CENTER_LON) * metersPerDegLon - worldOrigin.x;
    const zMeters = (CENTER_LAT - lat) * metersPerDegLat - worldOrigin.z;
    return {
      x: xMeters / scale,
      z: zMeters / scale,
    };
  }

  const tilePersist = params.has("tilePersist") ? params.get("tilePersist") === "1" : true;
  const gridRadius = Number(params.get("grid") ?? (tilePersist ? 6 : 4));
  const gridSize = gridRadius * 2 + 1;
  const tileRefreshMs = Math.max(0, numberParam("tileRefreshMs", 0));
  const level10Only = params.has("level10Only") ? params.get("level10Only") === "1" : false;
  const tileStream = params.get("tileStream") === "1";
  const debugEvents = params.get("debugEvents") === "1";
  const eventVerbose = params.get("eventVerbose") === "1";
  const eventBufferSize = Math.max(100, Math.min(5000, Math.round(numberParam("eventBuf", 600))));
  const eventDumpSize = Math.max(10, Math.min(250, Math.round(numberParam("eventDump", 80))));
  const rawLodLayers = clamp(Number(params.get("lod") ?? 4), 1, TILE_LEVEL + 1);
  const lodLayers = level10Only ? 1 : rawLodLayers;
  const minLodLevel = Math.max(0, TILE_LEVEL - (lodLayers - 1));
  const tileLayers = [];

  function levelYOffset(level) {
    // Keep higher-res tiles slightly above lower-res ones to avoid z-fighting.
    return -(TILE_LEVEL - level) * 5;
  }

  const textureCache = new Map();
  const heightGridCache = new Map();
  const streamedTiles = new Map();
  let streamedLayer = null;
  let terrainWorker = null;
  let terrainWorkerReady = false;
  let terrainWorkerFailed = false;
  const terrainWorkerRequests = new Map();
  let terrainWorkerReqId = 1;

  const captureEvents =
    debugEvents || debug || debugTerrain || debugPhysics || debugHeights || debugMesh || debugSeams || debugImagery;
  const terrainEvents = [];

  function pushTerrainEvent(type, data) {
    if (!captureEvents) return;
    terrainEvents.push({
      t: Math.round(performance.now()),
      type,
      ...data,
    });
    if (terrainEvents.length > eventBufferSize) {
      terrainEvents.splice(0, terrainEvents.length - eventBufferSize);
    }
  }

  function dumpTerrainEvents(reason, data) {
    if (!captureEvents) return;
    const events = terrainEvents.slice(-Math.min(terrainEvents.length, eventDumpSize));
    // eslint-disable-next-line no-console
    console.warn("[drive] recent events", {
      reason,
      ...data,
      count: events.length,
      events,
    });
  }

  function tileBounds(level, x, y) {
    const xCount = tilesX(level);
    const yCount = tilesY(level);
    const tileLonWidth = 360 / xCount;
    const tileLatHeight = 180 / yCount;
    const west = -180 + x * tileLonWidth;
    const east = west + tileLonWidth;
    const north = 90 - y * tileLatHeight;
    const south = north - tileLatHeight;
    return { west, east, north, south };
  }

  function latLonToLocalMeters(lat, lon) {
    const dx = (lon - CENTER_LON) * metersPerDegLon;
    const dz = (CENTER_LAT - lat) * metersPerDegLat;
    return { x: dx - worldOrigin.x, z: dz - worldOrigin.z };
  }

  function latLonToWorldMeters(lat, lon) {
    const dx = (lon - CENTER_LON) * metersPerDegLon;
    const dz = (CENTER_LAT - lat) * metersPerDegLat;
    return { x: dx, z: dz };
  }

  let lastCarLat = CENTER_LAT;
  let lastCarLon = CENTER_LON;

  function boundsContainsLatLon(bounds, lat, lon) {
    if (!bounds) return false;
    return lat <= bounds.north && lat >= bounds.south && lon >= bounds.west && lon <= bounds.east;
  }

  function worldMetersToLatLon(xMeters, zMeters) {
    const lat = CENTER_LAT - zMeters / metersPerDegLat;
    const lon = CENTER_LON + xMeters / metersPerDegLon;
    return { lat, lon };
  }

  function localMetersToLatLon(xMeters, zMeters) {
    const lat = CENTER_LAT - (zMeters + worldOrigin.z) / metersPerDegLat;
    const lon = CENTER_LON + (xMeters + worldOrigin.x) / metersPerDegLon;
    return { lat, lon };
  }

  async function getTileTexture(url) {
    if (textureCache.has(url)) {
      imageryLog("imagery cache hit", { url });
      return textureCache.get(url);
    }
    imageryLog("imagery fetch", { url });
    const texture = await loadTexture(url, renderer);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    textureCache.set(url, texture);
    return texture;
  }

  function requestTileTexture(mesh, url, tileBounds) {
    const now = performance.now();
    const retryAfterMs = 2500;

    if (mesh.userData.url !== url) {
      const prevUrl = mesh.userData.url ?? null;
      const prevStats = mesh.userData.heightStats ?? null;
      const prevApplied = Boolean(mesh.userData.heightsApplied);
      const carOnPrev = boundsContainsLatLon(mesh.userData.tileBounds, lastCarLat, lastCarLon);
      const carOnNext = boundsContainsLatLon(tileBounds, lastCarLat, lastCarLon);
      if (debugTerrain || debugHeights) {
        terrainLog("tile mesh rebind", {
          t: Math.round(performance.now()),
          level: mesh.userData.level ?? null,
          prevUrl,
          nextUrl: url,
          prevHeightsApplied: prevApplied,
          prevHeightMin: prevStats?.minHeight ?? null,
          prevHeightMax: prevStats?.maxHeight ?? null,
          prevCenterHeight: prevStats?.centerHeight ?? null,
          yOffsetMeters: mesh.position.y / WORLD_TO_RENDER,
          tileX: mesh.userData.tileX ?? null,
          tileY: mesh.userData.tileY ?? null,
          carLat: lastCarLat,
          carLon: lastCarLon,
          carOnPrevTile: carOnPrev,
          carOnNextTile: carOnNext,
        });
      }
      if (eventVerbose || carOnPrev || carOnNext) {
        pushTerrainEvent("tile-mesh-rebind", {
          level: mesh.userData.level ?? null,
          prevUrl,
          nextUrl: url,
          prevHeightsApplied: prevApplied,
          prevCenterHeight: prevStats?.centerHeight ?? null,
          yOffsetMeters: mesh.position.y / WORLD_TO_RENDER,
          tileX: mesh.userData.tileX ?? null,
          tileY: mesh.userData.tileY ?? null,
          carOnPrevTile: carOnPrev,
          carOnNextTile: carOnNext,
        });
      }
      imageryLog("imagery assign", { url });
      mesh.userData.url = url;
      mesh.userData.state = "idle";
      mesh.userData.failedAt = 0;
      mesh.userData.heightsApplied = false;
      mesh.userData.heightStats = null;
    }

    // Store tile bounds for height sampling
    mesh.userData.tileBounds = tileBounds;

    if (mesh.userData.state === "loaded") return;
    if (mesh.userData.state === "loading") return;
    if (mesh.userData.state === "failed" && now - (mesh.userData.failedAt ?? 0) < retryAfterMs) return;

    mesh.userData.state = "loading";
    mesh.userData.reqId = (mesh.userData.reqId ?? 0) + 1;
    const reqId = mesh.userData.reqId;
    imageryLog("imagery load start", { url, reqId });

    getTileTexture(url)
      .then((texture) => {
        if (mesh.userData.url !== url || mesh.userData.reqId !== reqId) return;
        mesh.material.map = texture;
        mesh.material.needsUpdate = true;
        mesh.userData.state = "loaded";
        mesh.visible = true;
        imageryLog("imagery load complete", { url, reqId });
        if (captureEvents && (debugEvents || debugImagery)) {
          pushTerrainEvent("imagery-loaded", {
            url,
            level: mesh.userData.level ?? null,
            tileX: mesh.userData.tileX ?? null,
            tileY: mesh.userData.tileY ?? null,
          });
        }

      // Sample and apply terrain heights if COG is loaded and terrain is enabled
      if (cogTerrainEnabled && cogImage && !mesh.userData.isBase && !mesh.userData.heightsApplied) {
        const segments = mesh.userData.segments || TERRAIN_SEGMENTS;
        if (noRenderHeights) {
          mesh.userData.heightsApplied = true;
          terrainLog("terrain height grid skipped", { url, segments });
          const carOnTile = boundsContainsLatLon(tileBounds, lastCarLat, lastCarLon);
          if (captureEvents && (eventVerbose || carOnTile)) {
            pushTerrainEvent("render-heights-skipped", {
              url,
              level: mesh.userData.level ?? null,
              tileX: mesh.userData.tileX ?? null,
              tileY: mesh.userData.tileY ?? null,
              segments,
              carOnTile,
            });
          }
          return;
        }
        const cachedHeights = heightGridCache.get(url);
        if (cachedHeights) {
          applyHeightsToMesh(mesh, cachedHeights, segments);
          terrainLog("terrain height grid cache hit", { url, segments });
          if (debugTerrain) {
            const stats = mesh.userData.heightStats ?? null;
            terrainLog("render heights applied", {
              t: Math.round(performance.now()),
              url,
              level: mesh.userData.level ?? null,
              tileX: mesh.userData.tileX ?? null,
              tileY: mesh.userData.tileY ?? null,
              segments,
              yOffsetMeters: mesh.position.y / WORLD_TO_RENDER,
              minHeight: stats?.minHeight ?? null,
              maxHeight: stats?.maxHeight ?? null,
              centerHeight: stats?.centerHeight ?? null,
              source: "cache",
              carOnTile: boundsContainsLatLon(tileBounds, lastCarLat, lastCarLon),
              carLat: lastCarLat,
              carLon: lastCarLon,
            });
          }
          const carOnTile = boundsContainsLatLon(tileBounds, lastCarLat, lastCarLon);
          if (captureEvents && (eventVerbose || carOnTile)) {
            const stats = mesh.userData.heightStats ?? null;
            pushTerrainEvent("render-heights-applied", {
              url,
              level: mesh.userData.level ?? null,
              tileX: mesh.userData.tileX ?? null,
              tileY: mesh.userData.tileY ?? null,
              segments,
              yOffsetMeters: mesh.position.y / WORLD_TO_RENDER,
              minHeight: stats?.minHeight ?? null,
              maxHeight: stats?.maxHeight ?? null,
              centerHeight: stats?.centerHeight ?? null,
              source: "cache",
              carOnTile,
            });
          }
          } else {
            terrainLog("terrain height grid request", { url, segments });
            const carOnTile = boundsContainsLatLon(tileBounds, lastCarLat, lastCarLon);
            if (captureEvents && (eventVerbose || carOnTile)) {
              pushTerrainEvent("render-heights-request", {
                url,
                level: mesh.userData.level ?? null,
                tileX: mesh.userData.tileX ?? null,
                tileY: mesh.userData.tileY ?? null,
                segments,
                carOnTile,
              });
            }
            sampleHeightGrid(tileBounds, segments).then((heights) => {
              if (heights && mesh.userData.url === url) {
                heightGridCache.set(url, heights);
                applyHeightsToMesh(mesh, heights, segments);
                terrainLog("terrain height grid applied", { url, segments });
                if (debugTerrain) {
                  const stats = mesh.userData.heightStats ?? null;
                  terrainLog("render heights applied", {
                    t: Math.round(performance.now()),
                    url,
                    level: mesh.userData.level ?? null,
                    tileX: mesh.userData.tileX ?? null,
                    tileY: mesh.userData.tileY ?? null,
                    segments,
                    yOffsetMeters: mesh.position.y / WORLD_TO_RENDER,
                    minHeight: stats?.minHeight ?? null,
                    maxHeight: stats?.maxHeight ?? null,
                    centerHeight: stats?.centerHeight ?? null,
                    source: "sample",
                    carOnTile: boundsContainsLatLon(tileBounds, lastCarLat, lastCarLon),
                    carLat: lastCarLat,
                    carLon: lastCarLon,
                  });
                }
                const carOnTileAfter = boundsContainsLatLon(tileBounds, lastCarLat, lastCarLon);
                if (captureEvents && (eventVerbose || carOnTileAfter)) {
                  const stats = mesh.userData.heightStats ?? null;
                  pushTerrainEvent("render-heights-applied", {
                    url,
                    level: mesh.userData.level ?? null,
                    tileX: mesh.userData.tileX ?? null,
                    tileY: mesh.userData.tileY ?? null,
                    segments,
                    yOffsetMeters: mesh.position.y / WORLD_TO_RENDER,
                    minHeight: stats?.minHeight ?? null,
                    maxHeight: stats?.maxHeight ?? null,
                    centerHeight: stats?.centerHeight ?? null,
                    source: "sample",
                    carOnTile: carOnTileAfter,
                  });
                }
              }
            });
          }
        }
      })
      .catch(() => {
        if (mesh.userData.url !== url || mesh.userData.reqId !== reqId) return;
        mesh.userData.state = "failed";
        mesh.userData.failedAt = performance.now();
        imageryLog("imagery load failed", { url, reqId });
        // Keep showing whatever was there before. If there's nothing underneath,
        // allow base tiles to remain visible as placeholder.
        if (!mesh.material.map) {
          mesh.visible = Boolean(mesh.userData.isBase) || level10Only || tileStream;
        }
      });
  }

  // Heightmap resolution per tile (32x32 = 1089 vertices)
  const TERRAIN_SEGMENTS = 8;

  function createTileLayer(level, { isBase, persist }) {
    const xTiles = tilesX(level);
    const yTiles = tilesY(level);
    const lonWidth = 360 / xTiles;
    const latHeight = 180 / yTiles;
    const tileWidthMeters = lonWidth * metersPerDegLon;
    const tileHeightMeters = latHeight * metersPerDegLat;
    const tileSizeMeters = Math.max(tileWidthMeters, tileHeightMeters);

    // Use segmented geometry for heightmap (32x32 segments = 33x33 vertices)
    const segments = isBase ? 1 : TERRAIN_SEGMENTS;
    const meshes = [];
    const yOffset = levelYOffset(level);
    const layerOffset = TILE_LEVEL - level;
    if (!persist) {
      const tileGeometry = new THREE.PlaneGeometry(
        tileWidthMeters * WORLD_TO_RENDER,
        tileHeightMeters * WORLD_TO_RENDER,
        segments,
        segments,
      );
      for (let row = 0; row < gridSize; row += 1) {
        for (let col = 0; col < gridSize; col += 1) {
          // Use StandardMaterial for 3D terrain lighting
          const material = isBase
            ? new THREE.MeshBasicMaterial({
              color: 0x0b0b0b,
              polygonOffset: true,
              polygonOffsetFactor: -1 - layerOffset,
              polygonOffsetUnits: -1 - layerOffset,
              depthWrite: false,
            })
            : new THREE.MeshStandardMaterial({
              color: 0xffffff,
              flatShading: true,
              polygonOffset: true,
              polygonOffsetFactor: -1 - layerOffset,
              polygonOffsetUnits: -1 - layerOffset,
            });
          const mesh = new THREE.Mesh(tileGeometry.clone(), material);
          mesh.rotation.x = -Math.PI / 2;
          mesh.receiveShadow = true;
          mesh.position.y = yOffset;
          mesh.renderOrder = 100 + level;
          mesh.visible = isBase;
          const offsetRow = row - gridRadius;
          const offsetCol = col - gridRadius;
          mesh.userData.bandDistMeters = Math.hypot(
            offsetCol * tileWidthMeters,
            offsetRow * tileHeightMeters,
          );
          mesh.userData.isBase = isBase;
          mesh.userData.state = "idle";
          mesh.userData.failedAt = 0;
          mesh.userData.reqId = 0;
          mesh.userData.heightsApplied = false;
          mesh.userData.segments = segments;
          mesh.userData.level = level;
          tileGroup.add(mesh);
          meshes.push(mesh);
        }
      }
    }

    return {
      level,
      xTiles,
      yTiles,
      lonWidth,
      latHeight,
      tileWidthMeters,
      tileHeightMeters,
      tileSizeMeters,
      meshes,
      lastCenterKey: null,
      lastUpdateAt: 0,
      isBase,
      freezeLogged: false,
      persistTiles: persist ? new Map() : null,
      segments,
    };
  }

  function createPersistTileMesh(layer, tileX, tileY) {
    const segments = layer.segments ?? (layer.isBase ? 1 : TERRAIN_SEGMENTS);
    const geometry = new THREE.PlaneGeometry(
      layer.tileWidthMeters * WORLD_TO_RENDER,
      layer.tileHeightMeters * WORLD_TO_RENDER,
      segments,
      segments,
    );
    const layerOffset = TILE_LEVEL - layer.level;
    const material = layer.isBase
      ? new THREE.MeshBasicMaterial({
        color: 0x0b0b0b,
        polygonOffset: true,
        polygonOffsetFactor: -1 - layerOffset,
        polygonOffsetUnits: -1 - layerOffset,
        depthWrite: false,
      })
      : new THREE.MeshStandardMaterial({
        color: 0xffffff,
        flatShading: true,
        polygonOffset: true,
        polygonOffsetFactor: -1 - layerOffset,
        polygonOffsetUnits: -1 - layerOffset,
      });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    mesh.position.y = levelYOffset(layer.level);
    mesh.renderOrder = 100 + layer.level;
    mesh.visible = layer.isBase;
    mesh.userData.isBase = layer.isBase;
    mesh.userData.state = "idle";
    mesh.userData.failedAt = 0;
    mesh.userData.reqId = 0;
    mesh.userData.heightsApplied = false;
    mesh.userData.segments = segments;
    mesh.userData.level = layer.level;
    mesh.userData.tileX = tileX;
    mesh.userData.tileY = tileY;
    return mesh;
  }

  // Load/render coarse tiles first so something shows up quickly, then refine.
  // If there's only a single layer, don't mark it as "base" so it can still load
  // imagery + heights.
  if (tileStream) {
    streamedLayer = {
      level: TILE_LEVEL,
      meshes: [],
      isBase: false,
      lastCenterKey: null,
      lastUpdateAt: 0,
      freezeLogged: false,
    };
    tileLayers.push(streamedLayer);
  } else {
    const hasBaseLayer = minLodLevel !== TILE_LEVEL;
    for (let level = minLodLevel; level <= TILE_LEVEL; level += 1) {
      tileLayers.push(
        createTileLayer(level, {
          isBase: hasBaseLayer && level === minLodLevel,
          persist: tilePersist,
        }),
      );
    }
  }

  const tileStreamFovDeg = Math.max(1, Math.min(180, numberParam("tileFov", 120)));
  const tileStreamAlwaysRadius = Math.max(0, Math.min(gridRadius, Math.round(numberParam("tileAlways", 1))));
  const tileStreamMaxTiles = Math.max(0, Math.round(numberParam("tileMax", 0)));
  const tileStreamMinSpeed = Math.max(0, numberParam("tileMinSpeed", 0.5)); // m/s

  function getTileMetrics(level) {
    const xTiles = tilesX(level);
    const yTiles = tilesY(level);
    const lonWidth = 360 / xTiles;
    const latHeight = 180 / yTiles;
    const tileWidthMeters = lonWidth * metersPerDegLon;
    const tileHeightMeters = latHeight * metersPerDegLat;
    return { xTiles, yTiles, tileWidthMeters, tileHeightMeters };
  }

  function clampTileY(level, y) {
    const yTiles = tilesY(level);
    return clamp(y, 0, yTiles - 1);
  }

  function wrapTileX(level, x) {
    const xTiles = tilesX(level);
    return ((x % xTiles) + xTiles) % xTiles;
  }

  function getMotionDirMeters() {
    if (!chassisBody) return null;
    const vx = chassisBody.velocity.x * travelScale;
    const vz = chassisBody.velocity.z * travelScale;
    const speed = Math.hypot(vx, vz);
    if (!Number.isFinite(speed) || speed < tileStreamMinSpeed) return null;
    return { x: vx / speed, z: vz / speed };
  }

  function positionStreamTile(mesh) {
    const worldX = mesh.userData.worldCenterX ?? 0;
    const worldZ = mesh.userData.worldCenterZ ?? 0;
    mesh.position.x = (worldX - worldOrigin.x) * WORLD_TO_RENDER;
    mesh.position.z = (worldZ - worldOrigin.z) * WORLD_TO_RENDER;
  }

  function ensureStreamTile(level, tileX, tileY) {
    const key = `${level}:${tileX}:${tileY}`;
    const existing = streamedTiles.get(key);
    if (existing) {
      positionStreamTile(existing);
      return;
    }

    const { tileWidthMeters, tileHeightMeters } = getTileMetrics(level);
    const segments = TERRAIN_SEGMENTS;
    const geometry = new THREE.PlaneGeometry(
      tileWidthMeters * WORLD_TO_RENDER,
      tileHeightMeters * WORLD_TO_RENDER,
      segments,
      segments,
    );
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      flatShading: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    mesh.renderOrder = 100 + level;
    mesh.visible = true;
    mesh.userData.isBase = false;
    mesh.userData.state = "idle";
    mesh.userData.failedAt = 0;
    mesh.userData.reqId = 0;
    mesh.userData.heightsApplied = false;
    mesh.userData.segments = segments;
    mesh.userData.level = level;
    mesh.userData.tileX = tileX;
    mesh.userData.tileY = tileY;

    const bounds = tileBounds(level, tileX, tileY);
    const tileCenterLat = (bounds.north + bounds.south) / 2;
    const tileCenterLon = (bounds.west + bounds.east) / 2;
    const worldMeters = latLonToWorldMeters(tileCenterLat, tileCenterLon);
    mesh.userData.worldCenterX = worldMeters.x;
    mesh.userData.worldCenterZ = worldMeters.z;
    positionStreamTile(mesh);

    const url = `${PROXY_BASE_PATH}/${level}/${tileX}/${tileY}.jpg`;
    requestTileTexture(mesh, url, bounds);

    tileGroup.add(mesh);
    streamedTiles.set(key, mesh);
    if (streamedLayer) {
      streamedLayer.meshes.push(mesh);
    }
  }

  function evictStreamTilesIfNeeded() {
    if (!tileStreamMaxTiles) return;
    if (streamedTiles.size <= tileStreamMaxTiles) return;
    // Evict farthest tiles first (keeps memory bounded in "tileStream" mode).
    if (!chassisBody) return;
    const { lat, lon } = chassisToLatLon(chassisBody, travelScale);
    const carWorld = latLonToWorldMeters(lat, lon);
    const entries = [...streamedTiles.entries()].map(([key, mesh]) => {
      const dx = (mesh.userData.worldCenterX ?? 0) - carWorld.x;
      const dz = (mesh.userData.worldCenterZ ?? 0) - carWorld.z;
      return { key, mesh, dist2: dx * dx + dz * dz };
    });
    entries.sort((a, b) => b.dist2 - a.dist2);
    const toEvict = entries.slice(0, streamedTiles.size - tileStreamMaxTiles);
    for (const { key, mesh } of toEvict) {
      streamedTiles.delete(key);
      if (streamedLayer) {
        const idx = streamedLayer.meshes.indexOf(mesh);
        if (idx >= 0) streamedLayer.meshes.splice(idx, 1);
      }
      tileGroup.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }

  function updateStreamTiles(carLat, carLon) {
    if (!streamedLayer) return;
    const now = performance.now();
    const level = streamedLayer.level;
    const center = tileXYFromLatLon(level, carLat, carLon);
    const centerKey = `${center.x}:${center.y}`;

    if (freezeTiles && streamedLayer.lastCenterKey !== null) {
      if (!streamedLayer.freezeLogged) {
        imageryLog("imagery refresh frozen", { level });
        streamedLayer.freezeLogged = true;
      }
      return;
    }

    const centerChanged = centerKey !== streamedLayer.lastCenterKey;
    const timedOut = tileRefreshMs > 0 && now - (streamedLayer.lastUpdateAt ?? 0) > tileRefreshMs;
    if (!centerChanged && !timedOut) return;

    streamedLayer.lastCenterKey = centerKey;
    streamedLayer.lastUpdateAt = now;

    const dir = getMotionDirMeters();
    const cosHalfFov = Math.cos(((tileStreamFovDeg / 2) * Math.PI) / 180);
    const carWorld = latLonToWorldMeters(carLat, carLon);

    let ensured = 0;
    for (let row = -gridRadius; row <= gridRadius; row += 1) {
      for (let col = -gridRadius; col <= gridRadius; col += 1) {
        const inAlways = Math.abs(row) <= tileStreamAlwaysRadius && Math.abs(col) <= tileStreamAlwaysRadius;
        if (!inAlways && dir) {
          const bounds = tileBounds(level, wrapTileX(level, center.x + col), clampTileY(level, center.y + row));
          const tileCenterLat = (bounds.north + bounds.south) / 2;
          const tileCenterLon = (bounds.west + bounds.east) / 2;
          const tileWorld = latLonToWorldMeters(tileCenterLat, tileCenterLon);
          const vx = tileWorld.x - carWorld.x;
          const vz = tileWorld.z - carWorld.z;
          const dist = Math.hypot(vx, vz);
          if (dist > 1e-6) {
            const dot = (vx / dist) * dir.x + (vz / dist) * dir.z;
            if (dot < cosHalfFov) continue;
          }
        }

        const tileX = wrapTileX(level, center.x + col);
        const tileY = clampTileY(level, center.y + row);
        ensureStreamTile(level, tileX, tileY);
        ensured += 1;
      }
    }

    evictStreamTilesIfNeeded();
    if (logTerrain) {
      console.log("[drive] tile stream refresh", {
        level,
        centerKey,
        gridRadius,
        tileStreamAlwaysRadius,
        tileStreamFovDeg,
        ensured,
        tiles: streamedTiles.size,
        reason: centerChanged ? "center-change" : "timer",
      });
      if (captureEvents) {
        pushTerrainEvent("tile-stream-refresh", {
          level,
          centerKey,
          gridRadius,
          tileStreamAlwaysRadius,
          tileStreamFovDeg,
          ensured,
          tiles: streamedTiles.size,
          reason: centerChanged ? "center-change" : "timer",
        });
      }
    }
  }

  function getRenderHeightAt(lat, lon) {
    for (let i = tileLayers.length - 1; i >= 0; i -= 1) {
      const layer = tileLayers[i];
      if (layer.isBase) continue;
      for (const mesh of layer.meshes) {
        const bounds = mesh.userData.tileBounds;
        if (!bounds) continue;
        if (lat > bounds.north || lat < bounds.south || lon < bounds.west || lon > bounds.east) continue;
        const segments = mesh.userData.segments || TERRAIN_SEGMENTS;
        const url = mesh.userData.url;
        let height = null;
        let source = null;
        if (url && heightGridCache.has(url)) {
          height = sampleHeightFromGrid(bounds, heightGridCache.get(url), segments, lat, lon);
          source = "cache";
        }
        if (height === null && mesh.userData.heightsApplied) {
          height = sampleHeightFromGeometry(mesh, bounds, segments, lat, lon);
          source = "geometry";
        }
        if (height !== null) {
          const yOffsetMeters = mesh.position.y / WORLD_TO_RENDER;
          return {
            heightMeters: height,
            heightMetersWithOffset: height + yOffsetMeters,
            yOffsetMeters,
            level: layer.level,
            url,
            source,
          };
        }
      }
    }
    return null;
  }

  function getRenderStackAt(lat, lon) {
    const stack = [];
    for (const layer of tileLayers) {
      if (layer.isBase) continue;
      for (const mesh of layer.meshes) {
        const bounds = mesh.userData.tileBounds;
        if (!bounds) continue;
        if (lat > bounds.north || lat < bounds.south || lon < bounds.west || lon > bounds.east) continue;
        stack.push({
          level: mesh.userData.level ?? layer.level ?? null,
          url: mesh.userData.url ?? null,
          state: mesh.userData.state ?? null,
          heightsApplied: Boolean(mesh.userData.heightsApplied),
          yOffsetMeters: mesh.position.y / WORLD_TO_RENDER,
          tileX: mesh.userData.tileX ?? null,
          tileY: mesh.userData.tileY ?? null,
        });
        break;
      }
    }
    stack.sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    return stack;
  }

  function logHeightComparison(lat, lon, chunkKey) {
    if (!logHeights) return;
    const compareId = (logHeightComparison.lastId ?? 0) + 1;
    logHeightComparison.lastId = compareId;
    const physicsHeight = physicsTerrain?.getHeightAt?.(lat, lon);
    const renderInfo = getRenderHeightAt(lat, lon);
    const renderHeightWithOffset = renderInfo?.heightMetersWithOffset ?? null;
    const cachedHeight = terrainHeightValid ? cachedTerrainHeight : null;
    heightLog("height compare", {
      compareId,
      lat,
      lon,
      chunkKey,
      physicsHeight,
      renderHeight: renderHeightWithOffset,
      renderHeightNoOffset: renderInfo?.heightMeters ?? null,
      renderYOffset: renderInfo?.yOffsetMeters ?? null,
      renderLevel: renderInfo?.level ?? null,
      renderSource: renderInfo?.source ?? null,
      renderUrl: renderInfo?.url ?? null,
      cachedTerrainHeight: cachedHeight,
      diffPhysicsRender: physicsHeight !== null && renderHeightWithOffset !== null
        ? physicsHeight - renderHeightWithOffset
        : null,
      diffPhysicsCached: physicsHeight !== null && cachedHeight !== null
        ? physicsHeight - cachedHeight
        : null,
    });
    if (!cogImage || logHeightComparison.cogInFlight) return;
    const now = performance.now();
    if (now - (logHeightComparison.lastCogAt ?? 0) < 500) return;
    logHeightComparison.lastCogAt = now;
    logHeightComparison.cogInFlight = true;
    sampleCogHeightBilinear(lat, lon)
      .then((height) => {
        heightLog("height compare cog", {
          compareId,
          cogBilinearHeight: height,
          diffPhysicsCog: physicsHeight !== null && height !== null ? physicsHeight - height : null,
          diffRenderCog: renderHeightWithOffset !== null && height !== null
            ? renderHeightWithOffset - height
            : null,
        });
      })
      .finally(() => {
        logHeightComparison.cogInFlight = false;
      });
  }
  setStatus("Loading Cybertruck…");
  const carRoot = new THREE.Group();
  let carModel = null;
  let modelFlip = false;
  let size = new THREE.Vector3(2, 1, 4).multiplyScalar(RENDER_SCALE);
  try {
    const gltf = await loadGltfFromZip(CAR_ZIP_PATH);
    carModel = gltf.scene;
    carModel.rotation.y = MODEL_YAW;
    carModel.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
        if (Array.isArray(child.material)) {
          child.material = child.material.map((mat) => {
            const clone = mat.clone();
            clone.metalness = 0.4;
            clone.roughness = 0.6;
            return clone;
          });
        } else if (child.material) {
          child.material = child.material.clone();
          child.material.metalness = 0.4;
          child.material.roughness = 0.6;
        }
      }
    });
    size = normalizeModel(carModel);
    carRoot.add(carModel);
  } catch (err) {
    if (debug) console.error("[car] load failed", err);
    setStatus("Cybertruck failed to load. Using placeholder.");
    const placeholderGeo = new THREE.BoxGeometry(size.x, size.y, size.z);
    const placeholderMat = new THREE.MeshStandardMaterial({ color: 0x8b8b8b });
    const placeholder = new THREE.Mesh(placeholderGeo, placeholderMat);
    carModel = placeholder;
    carModel.rotation.y = MODEL_YAW;
    carRoot.add(carModel);
  }
  if (carModel) {
    carModel.position.y += size.y * COM_OFFSET_FACTOR;
  }
  scene.add(carRoot);

  setStatus("Starting physics…");
  const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -3.711, 0),
  });
  // SAP broadphase can behave poorly with infinite planes + ray tests.
  // NaiveBroadphase is slower but reliable for this tiny scene.
  world.broadphase = new CANNON.NaiveBroadphase();
  world.allowSleep = true;
  world.solver.iterations = 25;
  world.defaultContactMaterial.contactEquationStiffness = 1e8;
  world.defaultContactMaterial.contactEquationRelaxation = 3;
  world.defaultContactMaterial.friction = 0.6;
  world.defaultContactMaterial.restitution = 0.0;
  world.defaultContactMaterial.frictionEquationStiffness = 1e7;
  world.defaultContactMaterial.frictionEquationRelaxation = 3;

  let physicsDebugger = null;
  let physicsDebugGroup = null;
  let debugTerrainGroup = null;
  let debugTerrainMeshes = new Map();

  function clearPhysicsDebug() {
    if (!physicsDebugGroup) return;
    physicsDebugGroup.traverse((child) => {
      if (child.isMesh) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((mat) => mat.dispose());
        } else {
          child.material?.dispose();
        }
      }
    });
    scene.remove(physicsDebugGroup);
    physicsDebugGroup = null;
    physicsDebugger = null;
  }

  function clearDebugTerrainMeshes() {
    if (!debugTerrainGroup) return;
    for (const [key, mesh] of debugTerrainMeshes.entries()) {
      meshLog("debug terrain mesh clear", { key });
      if (captureEvents) pushTerrainEvent("debug-terrain-mesh-clear", { key });
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((mat) => mat.dispose());
      } else {
        mesh.material.dispose();
      }
      debugTerrainGroup.remove(mesh);
    }
    debugTerrainMeshes.clear();
    scene.remove(debugTerrainGroup);
    debugTerrainGroup = null;
  }

  function buildDebugTerrainMesh(chunk) {
    const segments = chunk.segments;
    const rows = segments + 1;
    const cols = segments + 1;
    const sizeMeters = PHYSICS_TERRAIN_CHUNK_SIZE;
    const geometry = new THREE.PlaneGeometry(
      sizeMeters * WORLD_TO_RENDER,
      sizeMeters * WORLD_TO_RENDER,
      segments,
      segments,
    );
    const positionAttr = geometry.getAttribute("position");
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        const heightM = chunk.heights[idx] ?? 0;
        positionAttr.setZ(idx, heightM * WORLD_TO_RENDER);
      }
    }
    positionAttr.needsUpdate = true;
    geometry.computeVertexNormals();

    const material = new THREE.MeshBasicMaterial({
      color: 0x00ffff,
      wireframe: true,
      transparent: true,
      opacity: 0.4,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.x = (chunk.originX + sizeMeters * 0.5) * WORLD_TO_RENDER;
    mesh.position.z = (chunk.originZ + sizeMeters * 0.5) * WORLD_TO_RENDER;
    mesh.userData.segments = segments;
    return mesh;
  }

  function syncDebugTerrainMeshes(terrain) {
    if (!debugPhysics || !terrain?.chunks) return;
    if (!debugTerrainGroup) {
      debugTerrainGroup = new THREE.Group();
      scene.add(debugTerrainGroup);
    }
    const readyKeys = new Set();
    for (const [key, chunk] of terrain.chunks.entries()) {
      if (!chunk || chunk.state !== "ready" || !chunk.heights) continue;
      readyKeys.add(key);
      const existing = debugTerrainMeshes.get(key);
      if (existing && existing.userData.segments === chunk.segments) continue;
      if (existing) {
        existing.geometry.dispose();
        if (Array.isArray(existing.material)) {
          existing.material.forEach((mat) => mat.dispose());
        } else {
          existing.material.dispose();
        }
        debugTerrainGroup.remove(existing);
        debugTerrainMeshes.delete(key);
      }
      meshLog("debug terrain mesh rebuild", { key });
      if (captureEvents) pushTerrainEvent("debug-terrain-mesh-rebuild", { key });
      const mesh = buildDebugTerrainMesh(chunk);
      debugTerrainGroup.add(mesh);
      debugTerrainMeshes.set(key, mesh);
      meshLog("debug terrain mesh ready", {
        key,
        originX: chunk.originX,
        originZ: chunk.originZ,
        segments: chunk.segments,
      });
      if (captureEvents) {
        pushTerrainEvent("debug-terrain-mesh-ready", {
          key,
          originX: chunk.originX,
          originZ: chunk.originZ,
          segments: chunk.segments,
        });
      }
    }
    for (const key of debugTerrainMeshes.keys()) {
      if (!readyKeys.has(key)) {
        const mesh = debugTerrainMeshes.get(key);
        if (!mesh) continue;
        meshLog("debug terrain mesh clear", { key });
        if (captureEvents) pushTerrainEvent("debug-terrain-mesh-clear", { key });
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((mat) => mat.dispose());
        } else {
          mesh.material.dispose();
        }
        debugTerrainGroup.remove(mesh);
        debugTerrainMeshes.delete(key);
      }
    }
  }

  function setupPhysicsDebugger() {
    if (!debugPhysics) return;
    clearPhysicsDebug();
    physicsDebugGroup = new THREE.Group();
    physicsDebugGroup.scale.setScalar(WORLD_TO_RENDER * travelScale);
    scene.add(physicsDebugGroup);
    physicsDebugger = CannonDebugger(physicsDebugGroup, world, {
      color: 0x00ff00,
      scale: 1,
    });
    meshLog("physics debugger setup", {
      color: "0x00ff00",
      groupScale: physicsDebugGroup.scale.x,
      worldToRender: WORLD_TO_RENDER,
      travelScale,
      note: "Cannon bodies are rendered in green; physics chunk wireframe is cyan (0x00ffff).",
    });
    if (captureEvents) {
      pushTerrainEvent("physics-debugger-setup", {
        color: "0x00ff00",
        groupScale: physicsDebugGroup.scale.x,
        worldToRender: WORLD_TO_RENDER,
        travelScale,
      });
    }
  }

  const groundMaterial = new CANNON.Material("ground");
  const groundBody = new CANNON.Body({ mass: 0, material: groundMaterial });
  groundBody.addShape(new CANNON.Plane());
  const baseGroundQuat = new CANNON.Quaternion();
  baseGroundQuat.setFromEuler(-Math.PI / 2, 0, 0);
  groundBody.quaternion.copy(baseGroundQuat);
  world.addBody(groundBody);

  const sizePhysics = size.clone().multiplyScalar(PHYSICS_SCALE / RENDER_SCALE);
  const baseSizePhysics = size.clone().multiplyScalar(PHYSICS_SCALE / RENDER_SCALE);
  let vehicle = null;
  let chassisBody = null;
  let wheelRadius = 0;
  let initialY = 0;
  let wheelMeshes = [];
  let physicsScaleFactor = 1;
  let travelScale = 1;
  let physicsTerrain = null;
  let carSpawned = true;
  let spawnPending = false;
  let terrainHeightValid = false;

  function clearWheelMeshes() {
    wheelMeshes.forEach((mesh) => scene.remove(mesh));
    wheelMeshes = [];
  }

  function setupVehicle(scaleFactor, restoreState = null) {
    if (vehicle?.removeFromWorld) {
      vehicle.removeFromWorld(world);
    }
    clearWheelMeshes();

    // travelScale already maps physics units to meters, so keep physics shapes at base size
    physicsScaleFactor = 1;
    travelScale = scaleFactor;
    if (physicsTerrain) physicsTerrain.setScale(travelScale);
    const sizePhysics = baseSizePhysics.clone().multiplyScalar(physicsScaleFactor);
    const massScale = Math.pow(physicsScaleFactor, 0.7);
    const built = buildVehicle(world, sizePhysics, groundMaterial, massScale);
    vehicle = built.vehicle;
    chassisBody = built.chassisBody;
    wheelRadius = built.wheelRadius;
    initialY = built.initialY;
    // Scale damping with car size to prevent tumbling
    chassisBody.angularDamping = 0.4 + 0.1 * physicsScaleFactor;
    chassisBody.linearDamping = 0.2 + 0.05 * physicsScaleFactor;
    chassisBody.allowSleep = false;
    chassisBody.type = CANNON.Body.DYNAMIC;
    chassisBody.updateMassProperties();
    chassisBody.wakeUp();

    wheelMeshes = createWheelMeshes(vehicle, wheelRadius);
    wheelMeshes.forEach((mesh) => {
      mesh.scale.setScalar(WORLD_TO_RENDER * travelScale);
      scene.add(mesh);
    });

    if (restoreState && chassisBody) {
      const { lat, lon, quat, yOffset, yOffsetMeters } = restoreState;
      const pos = latLonToChassis(lat, lon, travelScale);
      chassisBody.position.x = pos.x;
      chassisBody.position.z = pos.z;
      const offset = Number.isFinite(yOffsetMeters)
        ? yOffsetMeters / travelScale
        : (yOffset ?? 0);
      chassisBody.position.y = Math.max(initialY, initialY + offset);
      if (quat) chassisBody.quaternion.copy(quat);
      chassisBody.velocity.setZero();
      chassisBody.angularVelocity.setZero();
      chassisBody.wakeUp();
    }
  }

  function setCarKinematic(isKinematic) {
    if (!chassisBody) return;
    chassisBody.type = isKinematic ? CANNON.Body.KINEMATIC : CANNON.Body.DYNAMIC;
    chassisBody.velocity.setZero();
    chassisBody.angularVelocity.setZero();
    chassisBody.updateMassProperties();
  }

  function spawnCarAt(lat, lon, heightMeters) {
    if (!chassisBody) return;
    const pos = latLonToChassis(lat, lon, travelScale);
    chassisBody.position.x = pos.x;
    chassisBody.position.z = pos.z;
    chassisBody.position.y = heightMeters / travelScale + initialY;
    chassisBody.velocity.setZero();
    chassisBody.angularVelocity.setZero();
    chassisBody.quaternion.set(0, 0, 0, 1);
    setCarKinematic(false);
    chassisBody.wakeUp();
    carRoot.visible = true;
    carSpawned = true;
    spawnPending = false;
    setStatus("Ready");
  }

  const controls = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    brake: false,
  };

  let zoomFactor = Number(zoomEl?.value ?? 5000);
  const updateZoomLabel = () => {
    zoomValueEl.textContent = `${zoomFactor.toFixed(0)}x`;
  };
  updateZoomLabel();
  zoomEl?.addEventListener("input", () => {
    zoomFactor = Number(zoomEl.value);
    updateZoomLabel();
  });

  let carScaleFactor = Number(sizeEl?.value ?? 20);
  const updateSizeLabel = () => {
    sizeValueEl.textContent = `${(carScaleFactor * RENDER_SCALE).toFixed(0)}x`;
  };
  const applyCarScale = () => {
    let restoreState = null;
    let restoreHeight = null;
    if (chassisBody) {
      const { lat, lon } = chassisToLatLon(chassisBody, travelScale);
      restoreHeight = physicsTerrain?.getHeightAt?.(lat, lon)
        ?? (terrainHeightValid ? cachedTerrainHeight : null);
      restoreState = {
        lat,
        lon,
        quat: chassisBody.quaternion.clone(),
        yOffsetMeters: (chassisBody.position.y - initialY) * travelScale,
      };
    }
    carRoot.scale.setScalar(carScaleFactor);
    setupVehicle(carScaleFactor, restoreState);
    if (chassisBody && restoreState) {
      if (restoreHeight !== null && restoreHeight !== undefined) {
        chassisBody.position.y = restoreHeight / travelScale + initialY;
      }
      chassisBody.velocity.setZero();
      chassisBody.angularVelocity.setZero();
      chassisBody.wakeUp();
    }
    setupPhysicsDebugger();
  };

  function shiftWorldOrigin(shiftXMeters, shiftZMeters) {
    if (!shiftXMeters && !shiftZMeters) return;
    worldOrigin.x += shiftXMeters;
    worldOrigin.z += shiftZMeters;
    const shiftX = shiftXMeters / travelScale;
    const shiftZ = shiftZMeters / travelScale;
    let aabbDirtyBodies = 0;
    for (const body of world.bodies) {
      body.position.x -= shiftX;
      body.position.z -= shiftZ;
      // cannon-es does not automatically mark AABBs dirty when Vec3 components mutate.
      // This is critical for static terrain bodies (mass=0): if their AABB is stale after an origin shift,
      // broadphase queries (including RaycastVehicle) can miss them entirely -> "falling through".
      // eslint-disable-next-line no-param-reassign
      body.aabbNeedsUpdate = true;
      body.updateAABB?.();
      aabbDirtyBodies += 1;
    }
    if (physicsTerrain) physicsTerrain.rekeyChunks();
    const renderShiftX = shiftXMeters * WORLD_TO_RENDER;
    const renderShiftZ = shiftZMeters * WORLD_TO_RENDER;
    camera.position.x -= renderShiftX;
    camera.position.z -= renderShiftZ;
    if (tileStream && streamedTiles.size) {
      for (const mesh of streamedTiles.values()) {
        mesh.position.x -= renderShiftX;
        mesh.position.z -= renderShiftZ;
      }
    }
    if (!tileStream && tileLayers.length) {
      for (const layer of tileLayers) {
        for (const mesh of layer.meshes) {
          mesh.position.x -= renderShiftX;
          mesh.position.z -= renderShiftZ;
        }
      }
    }
    if (debugTerrainGroup) {
      debugTerrainGroup.position.x -= renderShiftX;
      debugTerrainGroup.position.z -= renderShiftZ;
    }
    if (captureEvents) {
      pushTerrainEvent("origin-shift", {
        shiftXMeters,
        shiftZMeters,
        worldOrigin: { ...worldOrigin },
        aabbDirtyBodies,
      });
    }
    if (debug) {
      console.log("[drive] Floating origin shift", {
        shiftXMeters,
        shiftZMeters,
        worldOrigin: { ...worldOrigin },
        aabbDirtyBodies,
      });
    }
  }

  function maybeShiftOrigin() {
    if (!chassisBody) return;
    const localX = chassisBody.position.x * travelScale;
    const localZ = chassisBody.position.z * travelScale;
    if (Math.abs(localX) < FLOATING_ORIGIN_THRESHOLD && Math.abs(localZ) < FLOATING_ORIGIN_THRESHOLD) return;
    shiftWorldOrigin(localX, localZ);
  }
  updateSizeLabel();
  applyCarScale();
  sizeEl?.addEventListener("input", () => {
    carScaleFactor = Number(sizeEl.value);
    updateSizeLabel();
    applyCarScale();
  });

  if (hudEl && hudToggleEl) {
    hudToggleEl.addEventListener("click", () => {
      const isCollapsed = hudEl.classList.toggle("collapsed");
      hudToggleEl.textContent = isCollapsed ? "+" : "-";
      hudToggleEl.setAttribute("aria-label", isCollapsed ? "Expand HUD" : "Minimize HUD");
    });
  }

  // COG terrain sampling using geotiff.js
  let cogTiff = null;
  let cogImage = null;
  let cogTerrainEnabled = false;
  let cogSampleInFlight = false;
  let lastCogSampleAt = 0;
  let cachedTerrainHeight = 0;

  // COG metadata (from gdalinfo - Mars coordinates)
  // Origin: (180, 55), Pixel Size: (0.00337, -0.00337)
  // Covers lon 180-360 (or -180 to 0), lat -55 to 55
  const COG_ORIGIN_LON = 180;
  const COG_ORIGIN_LAT = 55;
  const COG_PIXEL_SIZE_LON = 0.003374135377809;
  const COG_PIXEL_SIZE_LAT = -0.003374129627926;
  const COG_WIDTH = 53347;
  const COG_HEIGHT = 32601;

  function initTerrainWorker() {
    if (!terrainWorkerEnabled || terrainWorker || terrainWorkerFailed) return;
    try {
      terrainWorker = new Worker(new URL("./terrain-worker.js", import.meta.url), { type: "module" });
    } catch (err) {
      terrainWorkerFailed = true;
      console.warn("[drive] terrain worker init failed:", err);
      return;
    }
    terrainWorker.onmessage = (event) => {
      const { type } = event.data ?? {};
      if (type === "ready") {
        terrainWorkerReady = true;
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
        console.warn("[drive] terrain worker sample error:", message);
        entry.resolve(null);
      }
    };
    terrainWorker.onerror = (err) => {
      terrainWorkerFailed = true;
      console.warn("[drive] terrain worker error:", err);
    };
    terrainWorker.postMessage({ type: "init", url: "/terrain/cog" });
  }

  async function loadCogTerrain() {
    if (cogTiff) return true;
    try {
      if (ionTerrainHintEl) ionTerrainHintEl.textContent = "Loading COG terrain...";
      cogTiff = await GeoTIFF.fromUrl("/terrain/cog", { allowFullFile: false });
      cogImage = await cogTiff.getImage();
      if (ionTerrainHintEl) ionTerrainHintEl.textContent = "COG terrain loaded. Height will update as you drive.";
      initTerrainWorker();
      // eslint-disable-next-line no-console
      console.log("[drive] COG terrain loaded:", {
        width: cogImage.getWidth(),
        height: cogImage.getHeight(),
        origin: cogImage.getOrigin(),
        resolution: cogImage.getResolution(),
      });
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[drive] Failed to load COG terrain:", err);
      if (ionTerrainHintEl) ionTerrainHintEl.textContent = `Failed to load COG: ${err.message}`;
      return false;
    }
  }

	  function latLonToPixel(lat, lon) {
	    const f = latLonToPixelF(lat, lon);
	    return {
	      x: Math.max(0, Math.min(COG_WIDTH - 1, Math.floor(f.x))),
	      y: Math.max(0, Math.min(COG_HEIGHT - 1, Math.floor(f.y))),
	    };
	  }

	  function latLonToPixelF(lat, lon) {
	    // Normalize longitude to 180-360 range (COG covers this range)
	    let normLon = lon;
	    if (normLon < 0) normLon += 360;
	    if (normLon < 180) normLon += 180;
	    const pixelX = (normLon - COG_ORIGIN_LON) / COG_PIXEL_SIZE_LON;
	    const pixelY = (lat - COG_ORIGIN_LAT) / COG_PIXEL_SIZE_LAT;
	    return { x: pixelX, y: pixelY };
	  }

  async function sampleCogHeight(lat, lon) {
    if (!cogImage) return null;
    try {
      const pixel = latLonToPixel(lat, lon);
      const raster = await cogImage.readRasters({
        window: [pixel.x, pixel.y, pixel.x + 1, pixel.y + 1],
      });
      const height = raster[0][0];
      // NoData value is -32768
      if (height <= -32000) return null;
      return height;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[drive] COG sample error:", err.message);
      return null;
    }
  }

  async function sampleCogHeightBilinear(lat, lon) {
    if (!cogImage) return null;
    try {
      let normLon = lon;
      if (normLon < 0) normLon += 360;
      if (normLon < 180) normLon += 180;
      const fx = (normLon - COG_ORIGIN_LON) / COG_PIXEL_SIZE_LON;
      const fy = (lat - COG_ORIGIN_LAT) / COG_PIXEL_SIZE_LAT;
      const x0 = clamp(Math.floor(fx), 0, COG_WIDTH - 2);
      const y0 = clamp(Math.floor(fy), 0, COG_HEIGHT - 2);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      const raster = await cogImage.readRasters({
        window: [x0, y0, x1 + 1, y1 + 1],
      });
      const data = raster[0];
      const width = x1 - x0 + 1;
      const h00 = data[0];
      const h10 = data[1];
      const h01 = data[width];
      const h11 = data[width + 1];
      if (h00 <= -32000 || h10 <= -32000 || h01 <= -32000 || h11 <= -32000) return null;
      const sx = fx - x0;
      const sy = fy - y0;
      const hx0 = h00 + (h10 - h00) * sx;
      const hx1 = h01 + (h11 - h01) * sx;
      return hx0 + (hx1 - hx0) * sy;
    } catch (err) {
      console.warn("[drive] COG bilinear sample error:", err.message);
      return null;
    }
  }

  /**
   * Sample a grid of heights from COG for terrain mesh vertices
   * Returns a Float32Array of heights in row-major order
   */
	  async function sampleHeightGridLocal(bounds, segments) {
	    if (!cogImage) return null;

	    const { south, north, west, east } = bounds;
	    const rows = segments + 1;
	    const cols = segments + 1;

	    try {
	      const pNW = latLonToPixelF(north, west);
	      const pNE = latLonToPixelF(north, east);
	      const pSW = latLonToPixelF(south, west);
	      const pSE = latLonToPixelF(south, east);
	      const minX = clamp(Math.floor(Math.min(pNW.x, pNE.x, pSW.x, pSE.x)), 0, COG_WIDTH - 1);
	      const maxX = clamp(Math.ceil(Math.max(pNW.x, pNE.x, pSW.x, pSE.x)), 0, COG_WIDTH - 1);
	      const minY = clamp(Math.floor(Math.min(pNW.y, pNE.y, pSW.y, pSE.y)), 0, COG_HEIGHT - 1);
	      const maxY = clamp(Math.ceil(Math.max(pNW.y, pNE.y, pSW.y, pSE.y)), 0, COG_HEIGHT - 1);

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

	      // Sample heights at vertex lat/lon positions (bilinear in pixel space)
	      const heights = new Float32Array(rows * cols);
	      for (let row = 0; row < rows; row++) {
	        for (let col = 0; col < cols; col++) {
	          const lat = north + (south - north) * (row / segments);
	          const lon = west + (east - west) * (col / segments);
	          const p = latLonToPixelF(lat, lon);
	          heights[row * cols + col] = sampleBilinearFromWindow(p.x, p.y);
	        }
	      }
	      return heights;
	    } catch (err) {
	      // eslint-disable-next-line no-console
      console.warn("[drive] Height grid sample error:", err.message);
      return null;
    }
  }

  function sampleHeightGridWorker(bounds, segments) {
    if (!terrainWorker || terrainWorkerFailed) return null;
    const id = terrainWorkerReqId++;
    return new Promise((resolve) => {
      terrainWorkerRequests.set(id, { resolve });
      terrainWorker.postMessage({ type: "sampleGrid", id, bounds, segments });
    });
  }

  async function sampleHeightGrid(bounds, segments) {
    if (!cogImage) return null;
    if (terrainWorkerEnabled && terrainWorker && !terrainWorkerFailed) {
      const heights = await sampleHeightGridWorker(bounds, segments);
      if (heights) return heights;
    }
    return sampleHeightGridLocal(bounds, segments);
  }

  function sampleHeightFromGrid(bounds, heights, segments, lat, lon) {
    if (!bounds || !heights) return null;
    const { west, east, north, south } = bounds;
    if (lon < west || lon > east || lat > north || lat < south) return null;
    const u = (lon - west) / (east - west);
    const v = (north - lat) / (north - south);
    const fx = u * segments;
    const fy = v * segments;
    const x0 = clamp(Math.floor(fx), 0, segments);
    const y0 = clamp(Math.floor(fy), 0, segments);
    const x1 = clamp(x0 + 1, 0, segments);
    const y1 = clamp(y0 + 1, 0, segments);
    const cols = segments + 1;
    const h00 = heights[y0 * cols + x0] ?? 0;
    const h10 = heights[y0 * cols + x1] ?? 0;
    const h01 = heights[y1 * cols + x0] ?? 0;
    const h11 = heights[y1 * cols + x1] ?? 0;
    const sx = fx - x0;
    const sy = fy - y0;
    const hx0 = h00 + (h10 - h00) * sx;
    const hx1 = h01 + (h11 - h01) * sx;
    return hx0 + (hx1 - hx0) * sy;
  }

  function sampleHeightFromGeometry(mesh, bounds, segments, lat, lon) {
    if (!mesh?.geometry) return null;
    const positionAttr = mesh.geometry.getAttribute("position");
    if (!positionAttr) return null;
    const { west, east, north, south } = bounds;
    if (lon < west || lon > east || lat > north || lat < south) return null;
    const u = (lon - west) / (east - west);
    const v = (north - lat) / (north - south);
    const fx = u * segments;
    const fy = v * segments;
    const x0 = clamp(Math.floor(fx), 0, segments);
    const y0 = clamp(Math.floor(fy), 0, segments);
    const x1 = clamp(x0 + 1, 0, segments);
    const y1 = clamp(y0 + 1, 0, segments);
    const cols = segments + 1;
    const idx00 = y0 * cols + x0;
    const idx10 = y0 * cols + x1;
    const idx01 = y1 * cols + x0;
    const idx11 = y1 * cols + x1;
    const h00 = (positionAttr.getZ(idx00) ?? 0) / WORLD_TO_RENDER;
    const h10 = (positionAttr.getZ(idx10) ?? 0) / WORLD_TO_RENDER;
    const h01 = (positionAttr.getZ(idx01) ?? 0) / WORLD_TO_RENDER;
    const h11 = (positionAttr.getZ(idx11) ?? 0) / WORLD_TO_RENDER;
    const sx = fx - x0;
    const sy = fy - y0;
    const hx0 = h00 + (h10 - h00) * sx;
    const hx1 = h01 + (h11 - h01) * sx;
    return hx0 + (hx1 - hx0) * sy;
  }

  function buildTrimeshFromHeights(heights, segments, sizeMeters, scale) {
    const rows = segments + 1;
    const cols = segments + 1;
    const vertices = new Array(rows * cols * 3);
    const indices = [];
    let v = 0;

    for (let row = 0; row < rows; row += 1) {
      const zMeters = (row / segments - 0.5) * sizeMeters;
      for (let col = 0; col < cols; col += 1) {
        const xMeters = (col / segments - 0.5) * sizeMeters;
        const heightMeters = heights[row * cols + col] ?? 0;
        vertices[v++] = xMeters / scale;
        vertices[v++] = heightMeters / scale;
        vertices[v++] = zMeters / scale;
      }
    }

    for (let row = 0; row < segments; row += 1) {
      for (let col = 0; col < segments; col += 1) {
        const tl = row * cols + col;
        const tr = tl + 1;
        const bl = (row + 1) * cols + col;
        const br = bl + 1;
        // Winding so triangle normals face +Y (upward) for raycasts.
        indices.push(tl, bl, tr);
        indices.push(tr, bl, br);
      }
    }

    return new CANNON.Trimesh(vertices, indices);
  }

  function edgeIndex(edge, i, cols, segments) {
    switch (edge) {
      case "west":
        return i * cols;
      case "east":
        return i * cols + segments;
      case "north":
        return i;
      case "south":
        return segments * cols + i;
      default:
        return null;
    }
  }

  function edgeMismatchStats(heightsA, heightsB, segments, edgeA, edgeB) {
    const cols = segments + 1;
    let maxDiff = 0;
    let sumDiff = 0;
    let count = 0;
    for (let i = 0; i <= segments; i += 1) {
      const idxA = edgeIndex(edgeA, i, cols, segments);
      const idxB = edgeIndex(edgeB, i, cols, segments);
      if (idxA === null || idxB === null) continue;
      const a = heightsA[idxA] ?? 0;
      const b = heightsB[idxB] ?? 0;
      const diff = Math.abs(a - b);
      if (diff > maxDiff) maxDiff = diff;
      sumDiff += diff;
      count += 1;
    }
    return {
      maxDiff,
      meanDiff: count ? sumDiff / count : 0,
    };
  }

  class PhysicsTerrain {
    constructor(worldRef, groundMat) {
      this.world = worldRef;
      this.groundMaterial = groundMat;
      this.enabled = false;
      this.scale = 1;
      this.chunkSize = PHYSICS_TERRAIN_CHUNK_SIZE;
      this.segments = PHYSICS_TERRAIN_SEGMENTS;
      this.radius = PHYSICS_TERRAIN_RADIUS;
      this.chunks = new Map();
      this.lastCenterKey = null;
      this.lastHeightLogAt = 0;
      this.lastHeightLogKey = null;
      this.lastSeamLogAt = new Map();
      this.bodyKeyById = new Map();
      this.buildPerFrame = PHYSICS_BUILD_PER_FRAME;
      this.buildBudgetMs = PHYSICS_BUILD_BUDGET_MS;
      this.urgentQueue = [];
      this.urgentCursor = 0;
      this.urgentSet = new Set();
      this.prefetchExtraRadius = PHYSICS_PREFETCH_EXTRA_RADIUS;
      this.prefetchPerFrame = PHYSICS_PREFETCH_PER_FRAME;
      this.prefetchBudgetMs = PHYSICS_PREFETCH_BUDGET_MS;
      this.prefetchQueue = [];
      this.prefetchCursor = 0;
      this.prefetchSet = new Set();
      this.prefetchCenterKey = null;
    }

    setEnabled(enabled) {
      if (this.enabled === enabled) return;
      this.enabled = enabled;
      if (!enabled) {
        this.clear();
        this.lastCenterKey = null;
      }
    }

    setScale(scale) {
      if (Math.abs(this.scale - scale) < 1e-4) return;
      this.scale = scale;
      this.clear();
      this.lastCenterKey = null;
    }

    clear() {
      for (const chunk of this.chunks.values()) {
        if (chunk.body) {
          this.bodyKeyById.delete(chunk.body.id);
          this.world.removeBody(chunk.body);
        }
      }
      this.chunks.clear();
    }

    getChunkCoords(lat, lon) {
      const meters = latLonToWorldMeters(lat, lon);
      const cx = Math.floor(meters.x / this.chunkSize);
      const cz = Math.floor(meters.z / this.chunkSize);
      return { cx, cz };
    }

    keyForLatLon(lat, lon) {
      const { cx, cz } = this.getChunkCoords(lat, lon);
      return `${cx}:${cz}`;
    }

    isReadyFor(lat, lon) {
      const key = this.keyForLatLon(lat, lon);
      const chunk = this.chunks.get(key);
      return chunk?.state === "ready";
    }

    getHeightAt(lat, lon) {
      const meters = latLonToLocalMeters(lat, lon);
      const { cx, cz } = this.getChunkCoords(lat, lon);
      const key = `${cx}:${cz}`;
      const chunk = this.chunks.get(key);
      if (!chunk || chunk.state !== "ready" || !chunk.heights) {
        if (logTerrain) {
          const now = performance.now();
          const reason = !chunk ? "missing" : chunk.state !== "ready" ? "not-ready" : "no-heights";
          const logKey = `${reason}:${key}`;
          if (logKey !== this.lastHeightLogKey || now - this.lastHeightLogAt > 1000) {
            this.lastHeightLogKey = logKey;
            this.lastHeightLogAt = now;
            const ageMs = chunk?.requestedAt ? now - chunk.requestedAt : null;
            console.warn("[drive] terrain height miss", {
              reason,
              key,
              lat,
              lon,
              chunks: this.chunks.size,
              state: chunk?.state ?? null,
              ageMs: ageMs !== null ? ageMs.toFixed(1) : null,
            });
            if (captureEvents) {
              pushTerrainEvent("terrain-height-miss", {
                reason,
                key,
                lat,
                lon,
                chunks: this.chunks.size,
                state: chunk?.state ?? null,
                ageMs,
              });
            }
          }
        }
        return null;
      }

      const localX = meters.x - chunk.originX;
      const localZ = meters.z - chunk.originZ;
      if (localX < 0 || localZ < 0 || localX > this.chunkSize || localZ > this.chunkSize) {
        if (logTerrain) {
          const now = performance.now();
          const reason = "out-of-bounds";
          const logKey = `${reason}:${key}`;
          if (logKey !== this.lastHeightLogKey || now - this.lastHeightLogAt > 1000) {
            this.lastHeightLogKey = logKey;
            this.lastHeightLogAt = now;
            console.warn("[drive] terrain height miss", {
              reason,
              key,
              lat,
              lon,
              localX,
              localZ,
              originX: chunk.originX,
              originZ: chunk.originZ,
              chunkSize: this.chunkSize,
            });
            if (captureEvents) {
              pushTerrainEvent("terrain-height-miss", {
                reason,
                key,
                lat,
                lon,
                localX,
                localZ,
                originX: chunk.originX,
                originZ: chunk.originZ,
                chunkSize: this.chunkSize,
              });
            }
          }
        }
        return null;
      }

      const segments = chunk.segments;
      const cols = segments + 1;
      const rows = segments + 1;
      const fx = (localX / this.chunkSize) * segments;
      const fz = (localZ / this.chunkSize) * segments;
      const x0 = Math.floor(fx);
      const z0 = Math.floor(fz);
      const x1 = Math.min(x0 + 1, segments);
      const z1 = Math.min(z0 + 1, segments);
      const sx = fx - x0;
      const sz = fz - z0;

      const idx = (row, col) => row * cols + col;
      const h00 = chunk.heights[idx(z0, x0)] ?? 0;
      const h10 = chunk.heights[idx(z0, x1)] ?? 0;
      const h01 = chunk.heights[idx(z1, x0)] ?? 0;
      const h11 = chunk.heights[idx(z1, x1)] ?? 0;

      const hx0 = h00 + (h10 - h00) * sx;
      const hx1 = h01 + (h11 - h01) * sx;
      return hx0 + (hx1 - hx0) * sz;
    }

    getChunk(lat, lon) {
      const key = this.keyForLatLon(lat, lon);
      return this.chunks.get(key) ?? null;
    }

    rekeyChunks() {
      if (!this.chunks.size) return;
      const next = new Map();
      for (const chunk of this.chunks.values()) {
        const cx = chunk.cx;
        const cz = chunk.cz;
        const worldX0 = Number.isFinite(chunk.worldX0) ? chunk.worldX0 : cx * this.chunkSize;
        const worldZ0 = Number.isFinite(chunk.worldZ0) ? chunk.worldZ0 : cz * this.chunkSize;
        chunk.worldX0 = worldX0;
        chunk.worldZ0 = worldZ0;
        const localX0 = worldX0 - worldOrigin.x;
        const localZ0 = worldZ0 - worldOrigin.z;
        chunk.originX = localX0;
        chunk.originZ = localZ0;
        if (chunk.body) {
          const centerX = localX0 + this.chunkSize * 0.5;
          const centerZ = localZ0 + this.chunkSize * 0.5;
          chunk.body.position.x = centerX / this.scale;
          chunk.body.position.z = centerZ / this.scale;
          // See shiftWorldOrigin(): direct Vec3 mutation won't automatically mark AABB dirty.
          // eslint-disable-next-line no-param-reassign
          chunk.body.aabbNeedsUpdate = true;
          chunk.body.updateAABB?.();
        }
        next.set(`${cx}:${cz}`, chunk);
      }
      this.chunks = next;
      this.lastCenterKey = null;
    }

    refreshUrgentQueue(centerKey, entries) {
      if (!entries.length) {
        this.urgentQueue = [];
        this.urgentCursor = 0;
        this.urgentSet.clear();
        return;
      }
      entries.sort((a, b) => a.dist2 - b.dist2);
      this.urgentQueue = entries;
      this.urgentCursor = 0;
      this.urgentSet = new Set(entries.map((entry) => entry.key));
      if (logTerrain) {
        console.log("[drive] physics build queue", {
          key: centerKey,
          radius: this.radius,
          queued: entries.length,
        });
      }
    }

    processUrgentQueue() {
      if (this.buildPerFrame <= 0) return this.urgentCursor < this.urgentQueue.length;
      if (this.urgentCursor >= this.urgentQueue.length) return false;
      const startAt = performance.now();
      let created = 0;
      while (this.urgentCursor < this.urgentQueue.length && created < this.buildPerFrame) {
        if (this.buildBudgetMs > 0 && performance.now() - startAt > this.buildBudgetMs) break;
        const entry = this.urgentQueue[this.urgentCursor];
        this.urgentCursor += 1;
        if (!entry) continue;
        this.urgentSet.delete(entry.key);
        if (this.chunks.has(entry.key)) continue;
        this.createChunk(entry.cx, entry.cz, entry.key);
        created += 1;
      }
      if (this.urgentCursor >= this.urgentQueue.length) {
        this.urgentQueue = [];
        this.urgentCursor = 0;
        this.urgentSet.clear();
      }
      return this.urgentCursor < this.urgentQueue.length;
    }

    getPrefetchRadius() {
      if (this.prefetchExtraRadius <= 0) return this.radius;
      return this.radius + this.prefetchExtraRadius;
    }

    refreshPrefetchQueue(cx, cz) {
      if (this.prefetchExtraRadius <= 0 || this.prefetchPerFrame <= 0) return;
      const prefetchRadius = this.getPrefetchRadius();
      if (prefetchRadius <= this.radius) return;
      const centerKey = `${cx}:${cz}`;
      if (centerKey === this.prefetchCenterKey) return;
      this.prefetchCenterKey = centerKey;

      const entries = [];
      for (let dz = -prefetchRadius; dz <= prefetchRadius; dz += 1) {
        for (let dx = -prefetchRadius; dx <= prefetchRadius; dx += 1) {
          const nx = cx + dx;
          const nz = cz + dz;
          const key = `${nx}:${nz}`;
          if (this.chunks.has(key)) continue;
          if (this.urgentSet.has(key)) continue;
          entries.push({ key, cx: nx, cz: nz, dist2: dx * dx + dz * dz });
        }
      }
      entries.sort((a, b) => a.dist2 - b.dist2);
      this.prefetchQueue = entries;
      this.prefetchCursor = 0;
      this.prefetchSet = new Set(entries.map((entry) => entry.key));
      if (logTerrain && entries.length) {
        console.log("[drive] physics prefetch queue", {
          key: centerKey,
          radius: prefetchRadius,
          extraRadius: this.prefetchExtraRadius,
          queued: entries.length,
        });
      }
    }

    processPrefetchQueue() {
      if (this.prefetchExtraRadius <= 0 || this.prefetchPerFrame <= 0) return;
      if (this.prefetchCursor >= this.prefetchQueue.length) return;
      const startAt = performance.now();
      let created = 0;
      while (this.prefetchCursor < this.prefetchQueue.length && created < this.prefetchPerFrame) {
        if (this.prefetchBudgetMs > 0 && performance.now() - startAt > this.prefetchBudgetMs) break;
        const entry = this.prefetchQueue[this.prefetchCursor];
        this.prefetchCursor += 1;
        if (!entry) continue;
        this.prefetchSet.delete(entry.key);
        if (this.chunks.has(entry.key)) continue;
        this.createChunk(entry.cx, entry.cz, entry.key);
        created += 1;
      }
      if (this.prefetchCursor >= this.prefetchQueue.length) {
        if (logTerrain && this.prefetchQueue.length) {
          console.log("[drive] physics prefetch complete", {
            key: this.prefetchCenterKey,
            queued: this.prefetchQueue.length,
          });
        }
        this.prefetchQueue = [];
        this.prefetchCursor = 0;
        this.prefetchSet.clear();
      }
    }

    processBuildQueues() {
      const urgentPending = this.processUrgentQueue();
      if (urgentPending) return;
      this.processPrefetchQueue();
    }

    logSeamMismatch(key) {
      if (!logSeams) return;
      const chunk = this.chunks.get(key);
      if (!chunk || chunk.state !== "ready" || !chunk.heights) return;
      const neighbors = [
        { dx: 1, dz: 0, edge: "east", neighborEdge: "west" },
        { dx: -1, dz: 0, edge: "west", neighborEdge: "east" },
        { dx: 0, dz: 1, edge: "south", neighborEdge: "north" },
        { dx: 0, dz: -1, edge: "north", neighborEdge: "south" },
      ];
      const now = performance.now();
      for (const neighbor of neighbors) {
        const nkey = `${chunk.cx + neighbor.dx}:${chunk.cz + neighbor.dz}`;
        const nChunk = this.chunks.get(nkey);
        if (!nChunk || nChunk.state !== "ready" || !nChunk.heights) continue;
        const seamKey = `${key}:${neighbor.edge}->${nkey}:${neighbor.neighborEdge}`;
        const lastAt = this.lastSeamLogAt.get(seamKey) ?? 0;
        if (now - lastAt < 2000) continue;
        this.lastSeamLogAt.set(seamKey, now);
        const stats = edgeMismatchStats(chunk.heights, nChunk.heights, this.segments, neighbor.edge, neighbor.neighborEdge);
        seamLog("terrain seam mismatch", {
          key,
          neighborKey: nkey,
          edge: neighbor.edge,
          neighborEdge: neighbor.neighborEdge,
          maxDiff: stats.maxDiff,
          meanDiff: stats.meanDiff,
          segments: this.segments,
        });
      }
    }

    update(carLat, carLon, dirMeters = null) {
      if (!this.enabled || !cogImage) return;

      const centerKey = this.keyForLatLon(carLat, carLon);
      if (centerKey === this.lastCenterKey) return;
      this.lastCenterKey = centerKey;
      const dir = forwardChunks && dirMeters ? dirMeters : null;
      terrainLog("physics center update", {
        key: centerKey,
        lat: carLat,
        lon: carLon,
        radius: this.radius,
        chunkSize: this.chunkSize,
        chunks: this.chunks.size,
        forwardChunks: Boolean(dir),
        chunkFovDeg: dir ? PHYSICS_CHUNK_FOV_DEG : null,
        chunkAlwaysRadius: dir ? PHYSICS_CHUNK_ALWAYS_RADIUS : null,
      });
      if (captureEvents) {
        pushTerrainEvent("physics-center-update", {
          key: centerKey,
          lat: carLat,
          lon: carLon,
          radius: this.radius,
          chunkSize: this.chunkSize,
          chunks: this.chunks.size,
          forwardChunks: Boolean(dir),
        });
      }

      const [centerXStr, centerZStr] = centerKey.split(":");
      const cx = Number(centerXStr);
      const cz = Number(centerZStr);

      const needed = new Set();
      const urgentEntries = [];
      const carWorld = dir ? latLonToWorldMeters(carLat, carLon) : null;
      const cosHalfFov = dir ? Math.cos(((PHYSICS_CHUNK_FOV_DEG / 2) * Math.PI) / 180) : null;
      for (let dz = -this.radius; dz <= this.radius; dz += 1) {
        for (let dx = -this.radius; dx <= this.radius; dx += 1) {
          const nx = cx + dx;
          const nz = cz + dz;
          const inAlways = dir
            ? Math.abs(dx) <= PHYSICS_CHUNK_ALWAYS_RADIUS && Math.abs(dz) <= PHYSICS_CHUNK_ALWAYS_RADIUS
            : true;
          if (dir && !inAlways && carWorld) {
            const chunkCenterX = (nx + 0.5) * this.chunkSize;
            const chunkCenterZ = (nz + 0.5) * this.chunkSize;
            const vx = chunkCenterX - carWorld.x;
            const vz = chunkCenterZ - carWorld.z;
            const dist = Math.hypot(vx, vz);
            if (dist > 1e-6) {
              const dot = (vx / dist) * dir.x + (vz / dist) * dir.z;
              if (dot < cosHalfFov) continue;
            }
          }
          const key = `${nx}:${nz}`;
          needed.add(key);
          if (!this.chunks.has(key)) {
            urgentEntries.push({ key, cx: nx, cz: nz, dist2: dx * dx + dz * dz });
          }
        }
      }

      for (const [key, chunk] of this.chunks) {
        if (!needed.has(key)) {
          if (noChunkEvict) {
            continue;
          }
          if (chunk.body) {
            this.bodyKeyById.delete(chunk.body.id);
            this.world.removeBody(chunk.body);
          }
          this.chunks.delete(key);
          terrainLog("physics chunk evict", { key });
          if (captureEvents) {
            pushTerrainEvent("physics-chunk-evict", {
              key,
            });
          }
        }
      }

      this.refreshUrgentQueue(centerKey, urgentEntries);
      this.refreshPrefetchQueue(cx, cz);
    }

    createChunk(cx, cz, key) {
      const chunk = {
        cx,
        cz,
        body: null,
        state: "loading",
        reqId: (Date.now() + Math.random()),
        requestedAt: performance.now(),
        loadMs: null,
        originSnapshot: { x: worldOrigin.x, z: worldOrigin.z },
        originX: 0,
        originZ: 0,
        worldX0: 0,
        worldZ0: 0,
        heights: null,
        segments: this.segments,
      };
      this.chunks.set(key, chunk);

      const size = this.chunkSize;
      const worldX0 = cx * size;
      const worldX1 = worldX0 + size;
      const worldZ0 = cz * size;
      const worldZ1 = worldZ0 + size;
      const cornerNW = worldMetersToLatLon(worldX0, worldZ0);
      const cornerNE = worldMetersToLatLon(worldX1, worldZ0);
      const cornerSW = worldMetersToLatLon(worldX0, worldZ1);

      const bounds = {
        west: cornerNW.lon,
        east: cornerNE.lon,
        north: cornerNW.lat,
        south: cornerSW.lat,
      };
      chunk.worldX0 = worldX0;
      chunk.worldZ0 = worldZ0;
      chunk.originX = worldX0 - worldOrigin.x;
      chunk.originZ = worldZ0 - worldOrigin.z;
      terrainLog("physics chunk request", {
        key,
        bounds,
        segments: this.segments,
      });
      if (captureEvents) {
        pushTerrainEvent("physics-chunk-request", {
          key,
          bounds,
          segments: this.segments,
          worldX0,
          worldZ0,
          originAtRequest: { ...chunk.originSnapshot },
        });
      }

      const reqId = chunk.reqId;
      sampleHeightGrid(bounds, this.segments)
        .then((heights) => {
          if (!this.enabled) return;
          const active = this.chunks.get(key);
          if (!active || active.reqId !== reqId) return;
          if (!heights) {
            active.state = "failed";
            return;
          }

          let minH = Infinity;
          let maxH = -Infinity;
          for (let i = 0; i < heights.length; i += 1) {
            const h = heights[i];
            if (h < minH) minH = h;
            if (h > maxH) maxH = h;
          }
          const shape = buildTrimeshFromHeights(heights, this.segments, size, this.scale);
          shape.updateTree?.();
          const body = new CANNON.Body({ mass: 0, material: this.groundMaterial });
          body.addShape(shape);
          const localX0Now = active.worldX0 - worldOrigin.x;
          const localZ0Now = active.worldZ0 - worldOrigin.z;
          const centerX = localX0Now + size * 0.5;
          const centerZ = localZ0Now + size * 0.5;
          body.position.set(centerX / this.scale, 0, centerZ / this.scale);
          // Ensure broadphase/raycast queries see the body at its new position.
          // eslint-disable-next-line no-param-reassign
          body.aabbNeedsUpdate = true;
          body.updateAABB?.();
          this.world.addBody(body);
          active.body = body;
          this.bodyKeyById.set(body.id, key);
          active.originX = localX0Now;
          active.originZ = localZ0Now;
          active.heights = heights;
          active.segments = this.segments;
          active.minHeight = minH;
          active.maxHeight = maxH;
          active.state = "ready";
          active.loadMs = performance.now() - active.requestedAt;
          if (captureEvents) {
            pushTerrainEvent("physics-chunk-ready", {
              key,
              bodyId: body.id,
              centerX,
              centerZ,
              originX: localX0Now,
              originZ: localZ0Now,
              minHeight: minH,
              maxHeight: maxH,
              loadMs: active.loadMs,
            });
          }
          const os = active.originSnapshot;
          if (logTerrain && os && (Math.abs(os.x - worldOrigin.x) > 1e-3 || Math.abs(os.z - worldOrigin.z) > 1e-3)) {
            console.warn("[drive] physics chunk load across origin shift", {
              key,
              originAtRequest: os,
              originNow: { ...worldOrigin },
            });
            if (captureEvents) {
              pushTerrainEvent("physics-chunk-ready-origin-shift", {
                key,
                originAtRequest: os,
                originNow: { ...worldOrigin },
              });
            }
          }
          if (logTerrain) {
            console.log("[drive] physics chunk ready", {
              key,
              bounds,
              minHeight: minH.toFixed(2),
              maxHeight: maxH.toFixed(2),
              loadMs: active.loadMs?.toFixed?.(1) ?? null,
            });
          }
          this.logSeamMismatch(key);
        })
        .catch((err) => {
          if (!this.enabled) return;
          const active = this.chunks.get(key);
          if (!active || active.reqId !== reqId) return;
          active.state = "failed";
          if (logTerrain) console.warn("[drive] physics chunk failed", err);
        });
    }
  }

  /**
   * Apply sampled heights to a tile mesh's geometry vertices
   */
  function applyHeightsToMesh(mesh, heights, segments) {
    const geometry = mesh.geometry;
    const positionAttr = geometry.getAttribute("position");
    const rows = segments + 1;
    const cols = segments + 1;
    const centerIdx = Math.floor(rows / 2) * cols + Math.floor(cols / 2);
    let minHeight = Infinity;
    let maxHeight = -Infinity;

    // PlaneGeometry vertices are arranged: X across, Y down (before rotation)
    // After -90° rotation around X, the Y values in position become Z (height)
    // The Z values become Y (lateral), but we want to modify the original Y (which maps to world Y after rotation)

    // Actually, we need to modify the Z component of the position attribute
    // because after rotating the plane by -90° around X:
    // - original X stays X
    // - original Y becomes Z (depth)
    // - original Z becomes -Y (height)
    // Wait, PlaneGeometry lies in XY plane, we rotate it to lie in XZ plane.
    // So we modify the Z component to displace the mesh upward.

    // For a PlaneGeometry in XY, after rotating -90° around X:
    // Point (x, y, 0) becomes (x, 0, y) in the rotated frame? No...
    // Actually the rotation is applied at render time. The geometry positions stay the same.
    // To make terrain height, we need to set the Z value of each vertex in the geometry.
    // Then when the mesh is rotated, this Z will point upward (become Y in world space).

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const vertexIdx = row * cols + col;
        // Height in meters - scale by WORLD_TO_RENDER to match render scale
        // Also apply some exaggeration to make terrain more visible
        const heightM = heights[vertexIdx] ?? 0;
        if (heightM < minHeight) minHeight = heightM;
        if (heightM > maxHeight) maxHeight = heightM;
        const scaledHeight = heightM * WORLD_TO_RENDER * 1.0; // Height exaggeration factor
        positionAttr.setZ(vertexIdx, scaledHeight);
      }
    }

    positionAttr.needsUpdate = true;
    geometry.computeVertexNormals();
    mesh.userData.heightsApplied = true;
    mesh.userData.heightStats = {
      minHeight: Number.isFinite(minHeight) ? minHeight : null,
      maxHeight: Number.isFinite(maxHeight) ? maxHeight : null,
      centerHeight: heights?.[centerIdx] ?? null,
      segments,
    };
  }

  physicsTerrain = new PhysicsTerrain(world, groundMaterial);
  physicsTerrain.setScale(travelScale);

  function enablePhysicsTerrain() {
    physicsTerrain.setEnabled(true);
  }

  function disablePhysicsTerrain() {
    physicsTerrain.setEnabled(false);
    if (!world.bodies.includes(groundBody)) {
      world.addBody(groundBody);
    }
    groundBody.position.y = 0;
    groundBody.quaternion.copy(baseGroundQuat);
  }

  function setIonTerrainUi(enabled) {
    cogTerrainEnabled = enabled;
    if (ionTerrainStateEl) {
      ionTerrainStateEl.textContent = enabled ? "on" : "off";
      ionTerrainStateEl.classList.toggle("on", enabled);
    }
  }

async function enableCogTerrain() {
  terrainLog("terrain enable requested", {
    centerLat: CENTER_LAT,
    centerLon: CENTER_LON,
    tileLevel: TILE_LEVEL,
    lodLayers,
    gridRadius,
    physicsChunk: PHYSICS_TERRAIN_CHUNK_SIZE,
    physicsRadius: PHYSICS_TERRAIN_RADIUS,
  });
  setStatus("Loading terrain…");
  const loaded = await loadCogTerrain();
  if (loaded) {
    setIonTerrainUi(true);
    enablePhysicsTerrain();
      spawnPending = true;
      carSpawned = false;
      carRoot.visible = false;
      setCarKinematic(true);
    setStatus("Terrain loaded. Preparing car…");
    // Start chunk loading immediately instead of waiting for the next animation frame.
    physicsTerrain?.update?.(CENTER_LAT, CENTER_LON);

      // Apply heights to all already-loaded tiles
      for (const layer of tileLayers) {
        if (layer.isBase) continue;
        for (const mesh of layer.meshes) {
          const tileBoundsData = mesh.userData.tileBounds;
          if (mesh.userData.state === "loaded" && tileBoundsData && !mesh.userData.heightsApplied) {
            const segments = mesh.userData.segments || TERRAIN_SEGMENTS;
            sampleHeightGrid(tileBoundsData, segments).then((heights) => {
              if (heights) {
                applyHeightsToMesh(mesh, heights, segments);
              }
            });
          }
        }
      }

      // Sample initial terrain height at spawn point and reposition car
      const spawnHeight = await sampleCogHeight(CENTER_LAT, CENTER_LON);
    if (spawnHeight !== null) {
      cachedTerrainHeight = spawnHeight;
      terrainHeightValid = true;
      terrainLog("terrain spawn height", {
        lat: CENTER_LAT,
        lon: CENTER_LON,
        height: spawnHeight,
      });
      if (terrainHeightEl) {
        terrainHeightEl.textContent = `${spawnHeight.toFixed(1)} m`;
      }
        // eslint-disable-next-line no-console
        console.log("[drive] Initial terrain height:", spawnHeight, "m, car Y:", chassisBody.position.y);
      }
    }
  }

function disableCogTerrain() {
  cogTerrainEnabled = false;
  terrainHeightValid = false;
  terrainLog("terrain disabled", { carSpawned, spawnPending });
  if (terrainHeightEl) terrainHeightEl.textContent = "--";
  setIonTerrainUi(false);
  disablePhysicsTerrain();
    carRoot.visible = true;
    spawnPending = false;
    carSpawned = true;
    setCarKinematic(false);
    if (ionTerrainHintEl) {
      ionTerrainHintEl.textContent = "Click to enable Mars terrain height sampling.";
    }
  }

  if (ionTerrainToggleEl) {
    ionTerrainToggleEl.addEventListener("click", (event) => {
      event.preventDefault();
      if (cogTerrainEnabled) disableCogTerrain();
      else enableCogTerrain();
    });
  }

  // Auto-enable terrain on page load
  enableCogTerrain();

  function handleKey(event, isDown) {
    const code = event.code || event.key;
    switch (code) {
      case "KeyW":
      case "w":
      case "W":
      case "ArrowUp":
        controls.forward = isDown;
        break;
      case "KeyS":
      case "s":
      case "S":
      case "ArrowDown":
        controls.backward = isDown;
        break;
      case "KeyA":
      case "a":
      case "A":
      case "ArrowLeft":
        controls.left = isDown;
        break;
      case "KeyD":
      case "d":
      case "D":
      case "ArrowRight":
        controls.right = isDown;
        break;
      case "Space":
        controls.brake = isDown;
        break;
      case "KeyR":
        if (isDown && chassisBody) {
          const { lat: resetLat, lon: resetLon } = chassisToLatLon(chassisBody, travelScale);
          const resetPos = latLonToChassis(resetLat, resetLon, travelScale);
          const resetHeight = physicsTerrain?.getHeightAt?.(resetLat, resetLon)
            ?? (terrainHeightValid ? cachedTerrainHeight : null);
          const resetY = Number.isFinite(resetHeight)
            ? resetHeight / travelScale + initialY
            : chassisBody.position.y;
          chassisBody.position.set(
            resetPos.x,
            resetY,
            resetPos.z,
          );
          chassisBody.velocity.setZero();
          chassisBody.angularVelocity.setZero();
          chassisBody.quaternion.set(0, 0, 0, 1);
          carRoot.visible = true;
          spawnPending = false;
          carSpawned = true;
        }
        break;
      case "KeyF":
        if (isDown && carModel) {
          modelFlip = !modelFlip;
          carModel.rotation.y = MODEL_YAW + (modelFlip ? Math.PI : 0);
        }
        break;
      default:
        return;
    }
    if (isDown && chassisBody) {
      chassisBody.wakeUp();
    }
    event.preventDefault();
  }

  const keyListenerOptions = { capture: true };
  window.addEventListener("keydown", (event) => handleKey(event, true), keyListenerOptions);
  window.addEventListener("keyup", (event) => handleKey(event, false), keyListenerOptions);
  window.addEventListener("blur", () => {
    controls.forward = false;
    controls.backward = false;
    controls.left = false;
    controls.right = false;
    controls.brake = false;
  });

  const cameraOffset = new THREE.Vector3(0, 4.5, -10);
  const lookOffset = new THREE.Vector3(0, 1.2, 0);
  const yawEuler = new THREE.Euler(0, 0, 0, "YXZ");
  const yawQuat = new THREE.Quaternion();
  const yawAxis = new THREE.Vector3(0, 1, 0);

  const clock = new THREE.Clock();
  let steer = 0;
  const baseSuspension = {
    stiffness: 40,
    relaxation: 3.5,
    compression: 6.5,
    maxForce: 100000,
  };

  function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.033);

    // Get current speed for physics calculations
    const speed = chassisBody ? chassisBody.velocity.length() : 0;

    // ─────────────────────────────────────────────────────────────────────────
    // STEERING: Speed-dependent steering with smooth response
    // ─────────────────────────────────────────────────────────────────────────
    const steerInput = (controls.left ? 1 : 0) + (controls.right ? -1 : 0);
    const effectiveMaxSteer = getEffectiveSteerAngle(1, speed, VEHICLE_CONFIG);
    const targetSteer = steerInput * effectiveMaxSteer;
    steer += (targetSteer - steer) * Math.min(1, delta * VEHICLE_CONFIG.steerResponseRate);

    const canDrive = !spawnPending;
    if (vehicle) {
      // Scale suspension with car size
      const suspensionScale = Math.sqrt(physicsScaleFactor);
      for (let i = 0; i < vehicle.wheelInfos.length; i += 1) {
        const wheel = vehicle.wheelInfos[i];
        wheel.suspensionStiffness = baseSuspension.stiffness * suspensionScale;
        wheel.dampingRelaxation = baseSuspension.relaxation * suspensionScale;
        wheel.dampingCompression = baseSuspension.compression * suspensionScale;
        wheel.maxSuspensionForce = baseSuspension.maxForce * suspensionScale;
      }

      // Apply steering to front wheels only
      vehicle.setSteeringValue(steer, 0);
      vehicle.setSteeringValue(steer, 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ENGINE & BRAKING: Realistic power delivery with drive type configuration
    // ─────────────────────────────────────────────────────────────────────────
    const carScaleBoost = Math.min(5, Math.max(1, carScaleFactor / 20));
    const baseEngineForce = 4500
      * Math.pow(physicsScaleFactor, 0.7)
      * Math.pow(carScaleBoost, 0.7)
      * 0.5;

    // Engine force curves based on speed (power drops at high speed)
    const maxSpeedEst = 40; // estimated top speed in physics units
    const speedRatio = clamp(speed / maxSpeedEst, 0, 1);
    const powerCurve = 1 - speedRatio * 0.6; // 40% power drop at max speed

    let engineForce = 0;
    let brakeFactor = 0;
    const isTurning = Math.abs(steer) > 0.05;
    const turnBoost = isTurning ? 1.2 : 1.0; // 20% more power when turning to compensate

    let forwardSpeed = 0;
    if (chassisBody) {
      const forwardDir = new CANNON.Vec3(0, 0, 1);
      chassisBody.quaternion.vmult(forwardDir, forwardDir);
      forwardSpeed = forwardDir.dot(chassisBody.velocity);
    }

    if (canDrive) {
      if (controls.forward) {
        engineForce = -baseEngineForce * powerCurve * turnBoost;
      } else if (controls.backward) {
        if (forwardSpeed > 0.5) {
          brakeFactor = 1;
        } else {
          engineForce = baseEngineForce * 0.5 * powerCurve * turnBoost; // Reverse is weaker
        }
      }
    } else {
      brakeFactor = 1;
      steer = 0;
    }

    if (vehicle) {
      // Distribute engine force based on drive type
      const frontForce = engineForce * VEHICLE_CONFIG.frontPowerBias;
      const rearForce = engineForce * (1 - VEHICLE_CONFIG.frontPowerBias);

      if (VEHICLE_CONFIG.driveType === 'AWD') {
        vehicle.applyEngineForce(frontForce, 0); // FL
        vehicle.applyEngineForce(frontForce, 1); // FR
        vehicle.applyEngineForce(rearForce, 2);  // RL
        vehicle.applyEngineForce(rearForce, 3);  // RR
      } else if (VEHICLE_CONFIG.driveType === 'FWD') {
        vehicle.applyEngineForce(engineForce, 0);
        vehicle.applyEngineForce(engineForce, 1);
        vehicle.applyEngineForce(0, 2);
        vehicle.applyEngineForce(0, 3);
      } else { // RWD
        vehicle.applyEngineForce(0, 0);
        vehicle.applyEngineForce(0, 1);
        vehicle.applyEngineForce(engineForce, 2);
        vehicle.applyEngineForce(engineForce, 3);
      }

      // Braking with front bias
      const brakeInput = Math.max(brakeFactor, controls.brake ? 1 : 0);
      if (brakeInput > 0) {
        const totalBrake = VEHICLE_CONFIG.maxBrakeForce * Math.pow(physicsScaleFactor, 0.7) / 500;
        const frontBrake = totalBrake * VEHICLE_CONFIG.brakeBias * brakeInput;
        const rearBrake = totalBrake * (1 - VEHICLE_CONFIG.brakeBias) * brakeInput;
        vehicle.setBrake(frontBrake, 0);
        vehicle.setBrake(frontBrake, 1);
        vehicle.setBrake(rearBrake, 2);
        vehicle.setBrake(rearBrake, 3);
      } else {
        // Only apply rolling resistance when NOT accelerating
        // This prevents braking from fighting with throttle during turns
        const isAccelerating = Math.abs(engineForce) > 0.01;
        if (isAccelerating) {
          // No resistance when throttle is pressed
          for (let i = 0; i < 4; i++) {
            vehicle.setBrake(0, i);
          }
        } else {
          // Small rolling resistance when coasting
          const rollingBrake = TIRE_CONFIG.rollingResistance * speed * 0.05;
          for (let i = 0; i < 4; i++) {
            vehicle.setBrake(rollingBrake, i);
          }
        }
      }
    }

	    // ─────────────────────────────────────────────────────────────────────────
	    // SIMPLE BODY DYNAMICS: rely on RaycastVehicle + damping
	    // ─────────────────────────────────────────────────────────────────────────
    if (chassisBody) {
      chassisBody.angularDamping = VEHICLE_CONFIG.angularDamping;
      chassisBody.linearDamping = VEHICLE_CONFIG.linearDamping;
    }

	    // Fixed stepping with max substeps for stability.
	    world.step(PHYSICS_FIXED_TIMESTEP, delta, PHYSICS_MAX_SUBSTEPS);
	    maybeShiftOrigin();

	    // Debug logging for wheel contact issues (post-step, so it's aligned with current raycasts)
	    const wheelsOnGround = vehicle ? vehicle.numWheelsOnGround : 0;
	    const throttlePressed = controls.forward || controls.backward;
	    if (throttlePressed && wheelsOnGround === 0) {
	      const now = performance.now();
	      if (!animate.lastNoContactLogAt || now - animate.lastNoContactLogAt > 1000) {
	        animate.lastNoContactLogAt = now;
	        const y = chassisBody?.position?.y ?? 0;
	        if (debug) {
	          console.warn("[drive] wheels=0 while throttling", {
	            chassisY: y,
	            physicsScaleFactor,
	            travelScale,
	          });
	        }
	      }
	    }

	    if (chassisBody) {
	      carRoot.position.set(
	        chassisBody.position.x * WORLD_TO_RENDER * travelScale,
        chassisBody.position.y * WORLD_TO_RENDER * travelScale,
        chassisBody.position.z * WORLD_TO_RENDER * travelScale,
      );
      carRoot.quaternion.copy(chassisBody.quaternion);
    }

    if (vehicle) {
      updateWheelMeshes(vehicle, wheelMeshes, WORLD_TO_RENDER * travelScale);
    }
    if (physicsDebugger) {
      physicsDebugger.update();
    }
    const carLatLon = chassisBody ? chassisToLatLon(chassisBody, travelScale) : { lat: CENTER_LAT, lon: CENTER_LON };
    const carLat = carLatLon.lat;
    const carLon = carLatLon.lon;
    lastCarLat = carLat;
    lastCarLon = carLon;

    if ((debug || debugPhysics) && vehicle) {
      const now = performance.now();
      if (!animate.lastWheelLogAt || now - animate.lastWheelLogAt > 1000) {
        animate.lastWheelLogAt = now;
        const hits = vehicle.wheelInfos.map((wheel) => Boolean(wheel.raycastResult?.hasHit));
        const hitCount = hits.filter(Boolean).length;
        const firstHit = vehicle.wheelInfos.find((wheel) => wheel.raycastResult?.hasHit);
        const hitY = firstHit?.raycastResult?.hitPointWorld?.y;
        console.log("[drive] wheel hits", {
          hitCount,
          hits,
          hitY: hitY !== undefined ? hitY.toFixed(2) : null,
          chunkReady: physicsTerrain?.isReadyFor?.(carLat, carLon),
        });
        if (captureEvents && hitCount !== animate.lastHitCount) {
          animate.lastHitCount = hitCount;
          pushTerrainEvent("wheel-hits-sample", {
            hitCount,
            hits,
            hitY: hitY ?? null,
            carLat,
            carLon,
            chunkReady: physicsTerrain?.isReadyFor?.(carLat, carLon) ?? null,
            chunkKey: physicsTerrain?.keyForLatLon?.(carLat, carLon) ?? null,
          });
        }
      }
    }

    if ((debug || debugPhysics) && chassisBody) {
      const now = performance.now();
      if (!animate.lastTerrainDebugAt || now - animate.lastTerrainDebugAt > 1000) {
        animate.lastTerrainDebugAt = now;
        const terrainHeight = physicsTerrain?.getHeightAt?.(carLat, carLon);
        const carHeightMeters = chassisBody.position.y * travelScale;
        if (terrainHeight !== null && carHeightMeters < terrainHeight - 2) {
          const delta = carHeightMeters - terrainHeight;
          console.warn("[drive] car below terrain", {
            carHeightMeters: carHeightMeters.toFixed(2),
            terrainHeight: terrainHeight.toFixed(2),
            delta: delta.toFixed(2),
          });
          if (captureEvents) {
            pushTerrainEvent("car-below-terrain", {
              carHeightMeters,
              terrainHeight,
              delta,
              chunkKey: physicsTerrain?.keyForLatLon?.(carLat, carLon) ?? null,
            });
          }
          if (
            captureEvents
            && Number.isFinite(delta)
            && delta < -20
            && (!animate.lastBelowTerrainDumpAt || now - animate.lastBelowTerrainDumpAt > 2000)
          ) {
            animate.lastBelowTerrainDumpAt = now;
            dumpTerrainEvents("car-below-terrain", {
              carHeightMeters,
              terrainHeight,
              delta,
              carLat,
              carLon,
              chunkKey: physicsTerrain?.keyForLatLon?.(carLat, carLon) ?? null,
            });
          }
        }
      }
    }

    // Sample terrain height from COG
    if (cogTerrainEnabled && cogImage && !cogSampleInFlight) {
      const now = performance.now();
      if (now - lastCogSampleAt > 200) { // Sample more frequently for smoother terrain following
        lastCogSampleAt = now;
        cogSampleInFlight = true;
        sampleCogHeight(carLat, carLon)
          .then((height) => {
            if (height !== null) {
              cachedTerrainHeight = height;
              terrainHeightValid = true;
              if (terrainHeightEl) {
                terrainHeightEl.textContent = `${height.toFixed(1)} m`;
              }
            }
          })
          .finally(() => {
            cogSampleInFlight = false;
          });
      }
    }

    if (physicsTerrain) {
      physicsTerrain.update(carLat, carLon, forwardChunks ? getMotionDirMeters() : null);
      physicsTerrain.processBuildQueues();
    }

    if (debugPhysics && physicsTerrain) {
      syncDebugTerrainMeshes(physicsTerrain);
    }

    if (spawnPending && physicsTerrain?.isReadyFor?.(CENTER_LAT, CENTER_LON)) {
      const physicsHeight = physicsTerrain?.getHeightAt?.(CENTER_LAT, CENTER_LON);
      if (physicsHeight !== null) {
        spawnCarAt(CENTER_LAT, CENTER_LON, physicsHeight);
      } else if (terrainHeightValid) {
        spawnCarAt(CENTER_LAT, CENTER_LON, cachedTerrainHeight);
      }
    }

    const terrainHeight = physicsTerrain?.getHeightAt?.(carLat, carLon);
    const physicsTerrainReady = physicsTerrain?.isReadyFor?.(carLat, carLon);
    const missingTerrainHeight = terrainHeight === null || terrainHeight === undefined;
    const now = performance.now();
    const carChunkKey = physicsTerrain?.keyForLatLon?.(carLat, carLon) ?? null;
    if ((logTerrain || logHeights) && carChunkKey !== animate.lastCarChunkKey) {
      const prevChunkKey = animate.lastCarChunkKey;
      const prevTerrainHeight = animate.lastChunkTerrainHeight ?? null;
      animate.lastCarChunkKey = carChunkKey;
      const chunk = physicsTerrain?.getChunk?.(carLat, carLon);
      animate.lastChunkTerrainHeight = terrainHeight;
      console.log("[drive] car chunk change", {
        prevChunkKey,
        carChunkKey,
        chunkState: chunk?.state ?? null,
        minHeight: chunk?.minHeight ?? null,
        maxHeight: chunk?.maxHeight ?? null,
        terrainHeight,
        terrainDelta: prevTerrainHeight !== null && terrainHeight !== null
          ? (terrainHeight - prevTerrainHeight)
          : null,
      });
      if (captureEvents) {
        pushTerrainEvent("car-chunk-change", {
          prevChunkKey,
          carChunkKey,
          chunkState: chunk?.state ?? null,
          terrainHeight,
          terrainDelta:
            prevTerrainHeight !== null && terrainHeight !== null ? (terrainHeight - prevTerrainHeight) : null,
        });
      }
      logHeightComparison(carLat, carLon, carChunkKey);
    }
	    if (logTerrain && chassisBody && animate.lastWheelsOnGround !== wheelsOnGround) {
	      animate.lastWheelsOnGround = wheelsOnGround;
	      console.log("[drive] wheel contact change", {
	        wheelsOnGround,
	        carHeight: chassisBody.position.y * travelScale,
	        terrainHeight,
	        physicsTerrainReady,
	        chunkKey: carChunkKey,
	      });
      if (captureEvents) {
        pushTerrainEvent("wheel-contact-change", {
          wheelsOnGround,
          carHeight: chassisBody.position.y * travelScale,
          terrainHeight,
          physicsTerrainReady,
          chunkKey: carChunkKey,
        });
      }
      const shouldDumpContactLoss = wheelsOnGround === 0 && (debugEvents || debugTerrain || debugHeights);
      if (shouldDumpContactLoss) {
        const stack = getRenderStackAt(carLat, carLon);
        const dumpData = {
          t: Math.round(performance.now()),
          carLat,
          carLon,
          chunkKey: carChunkKey,
          carHeight: chassisBody.position.y * travelScale,
          terrainHeight,
          physicsTerrainReady,
          groundInWorld: world.bodies.includes(groundBody),
          stack,
        };
        console.warn("[drive] render stack at contact loss", {
          ...dumpData,
        });
        dumpTerrainEvents("wheel-contact-loss", {
          ...dumpData,
        });
	      }
	      if (wheelsOnGround === 0 && vehicle) {
	        const wheelInfos = vehicle.wheelInfos ?? [];
	        const maxRay = wheelInfos.reduce((max, wheel) => {
	          const rayLen = (wheel.suspensionRestLength ?? 0)
	            + (wheel.maxSuspensionTravel ?? 0)
	            + (wheel.radius ?? 0);
	          return Math.max(max, rayLen);
	        }, 0);
	        const heightGap = terrainHeight !== null && terrainHeight !== undefined
	          ? (chassisBody.position.y * travelScale - terrainHeight)
	          : null;
	        const maxRayMeters = maxRay * travelScale;
	        const perWheel = wheelInfos.map((wheel, index) => {
	          // Compute a "fresh" ray using chassis + wheelInfo (independent of RaycastVehicle's internals)
	          // so we can confirm whether the physics world has a hittable terrain body under each wheel.
	          let computedRayFrom = null;
	          let computedRayTo = null;
	          let computedRayLen = null;
	          let manualHasHit = null;
	          let manualHitBodyId = null;
	          let manualHitShapeId = null;
	          let manualHitChunkKey = null;
	          let manualHitBodyType = null;
	          let manualHitDistance = null;
	          let manualHitPointY = null;
	          let manualHitNormalY = null;
	          let manualHitBodyPos = null;
	          let wheelConnLatLon = null;
	          let wheelConnChunkKey = null;
	          let wheelConnChunkState = null;
	          let wheelConnChunkBodyId = null;

	          try {
	            const directionLocal = wheel.directionLocal ?? new CANNON.Vec3(0, -1, 0);
	            const dirWorld = new CANNON.Vec3();
	            chassisBody.quaternion.vmult(directionLocal, dirWorld);

	            const connLocal = wheel.chassisConnectionPointLocal ?? new CANNON.Vec3(0, 0, 0);
	            const fromWorld = new CANNON.Vec3();
	            chassisBody.quaternion.vmult(connLocal, fromWorld);
	            fromWorld.vadd(chassisBody.position, fromWorld);

	            const rayLen =
	              (wheel.suspensionRestLength ?? 0)
	              + (wheel.maxSuspensionTravel ?? 0)
	              + (wheel.radius ?? 0);
	            const toWorld = new CANNON.Vec3(
	              fromWorld.x + dirWorld.x * rayLen,
	              fromWorld.y + dirWorld.y * rayLen,
	              fromWorld.z + dirWorld.z * rayLen,
	            );

	            computedRayFrom = fromWorld;
	            computedRayTo = toWorld;
	            computedRayLen = rayLen;

	            const connMetersX = fromWorld.x * travelScale;
	            const connMetersZ = fromWorld.z * travelScale;
	            wheelConnLatLon = localMetersToLatLon(connMetersX, connMetersZ);
	            wheelConnChunkKey = physicsTerrain?.keyForLatLon?.(wheelConnLatLon.lat, wheelConnLatLon.lon) ?? null;
	            if (wheelConnChunkKey && physicsTerrain?.chunks?.get) {
	              const chunk = physicsTerrain.chunks.get(wheelConnChunkKey) ?? null;
	              wheelConnChunkState = chunk?.state ?? null;
	              wheelConnChunkBodyId = chunk?.body?.id ?? null;
	            }

	            const result = new CANNON.RaycastResult();
	            const options = {
	              collisionFilterGroup: wheel.collisionFilterGroup ?? 1,
	              collisionFilterMask: wheel.collisionFilterMask ?? -1,
	              skipBackfaces: true,
	            };
	            world.raycastClosest(fromWorld, toWorld, options, result);

	            if (result.hasHit && result.body === chassisBody) {
	              // Ignore self-hits; treat as no-hit for this diagnostic.
	              result.reset();
	            }
	            manualHasHit = Boolean(result.hasHit);
	            const hitBody = result.body ?? null;
	            manualHitBodyId = hitBody?.id ?? null;
	            manualHitShapeId = result.shape?.id ?? null;
	            if (manualHitBodyId !== null && manualHitBodyId !== undefined) {
	              manualHitChunkKey = physicsTerrain?.bodyKeyById?.get?.(manualHitBodyId) ?? null;
	            }
	            manualHitBodyType = hitBody
	              ? hitBody === groundBody
	                ? "ground-plane"
	                : manualHitChunkKey
	                  ? "terrain-chunk"
	                  : "other"
	              : "none";
	            manualHitDistance = Number.isFinite(result.distance) ? result.distance : null;
	            manualHitPointY = result.hitPointWorld?.y ?? null;
	            manualHitNormalY = result.hitNormalWorld?.y ?? null;
	            manualHitBodyPos = hitBody
	              ? {
	                x: hitBody.position.x * travelScale,
	                y: hitBody.position.y * travelScale,
	                z: hitBody.position.z * travelScale,
	              }
	              : null;
	          } catch (err) {
	            manualHasHit = null;
	          }

	          const rr = wheel.raycastResult;
	          const hasHit = Boolean(rr?.hasHit);
	          const hitBody = rr?.body ?? null;
	          const hitBodyId = hitBody?.id ?? null;
	          const hitShapeId = rr?.shape?.id ?? null;
          const hitChunkKey =
            hitBodyId !== null && hitBodyId !== undefined
              ? (physicsTerrain?.bodyKeyById?.get(hitBodyId) ?? null)
              : null;
          const hitBodyType = hitBody
            ? hitBody === groundBody
              ? "ground-plane"
              : hitChunkKey
                ? "terrain-chunk"
                : "other"
            : "none";
          const rayFrom = rr?.rayFromWorld;
	          const rayTo = rr?.rayToWorld;
	          const rayLen =
	            rayFrom && rayTo
	              ? Math.sqrt(
	                (rayFrom.x - rayTo.x) ** 2
	                  + (rayFrom.y - rayTo.y) ** 2
	                  + (rayFrom.z - rayTo.z) ** 2,
	              )
	              : null;
	          const wheelPos = wheel.worldTransform?.position ?? null;
	          const wheelLatLon =
	            wheelPos
	              ? localMetersToLatLon(wheelPos.x * travelScale, wheelPos.z * travelScale)
	              : null;
	          const wheelTerrainHeight =
	            wheelLatLon ? physicsTerrain?.getHeightAt?.(wheelLatLon.lat, wheelLatLon.lon) : null;
	          return {
	            index,
	            hasHit,
	            hitBodyId,
	            hitShapeId,
	            hitBodyType,
	            hitChunkKey,
	            hitDistance: rr?.distance ?? null,
	            hitPointY: rr?.hitPointWorld?.y ?? null,
	            hitNormalY: rr?.hitNormalWorld?.y ?? null,
	            hitBodyPos: hitBody
	              ? {
	                x: hitBody.position.x * travelScale,
	                y: hitBody.position.y * travelScale,
	                z: hitBody.position.z * travelScale,
	              }
	              : null,
	            collisionFilterGroup: wheel.collisionFilterGroup ?? null,
	            collisionFilterMask: wheel.collisionFilterMask ?? null,
	            rayFromY: rayFrom?.y ?? null,
	            rayToY: rayTo?.y ?? null,
	            rayLen: rayLen ?? null,
	            rayLenMeters: rayLen !== null ? rayLen * travelScale : null,
	            computedRayFromY: computedRayFrom?.y ?? null,
	            computedRayToY: computedRayTo?.y ?? null,
	            computedRayLen: computedRayLen ?? null,
	            computedRayLenMeters: computedRayLen !== null ? computedRayLen * travelScale : null,
	            manualHasHit,
	            manualHitBodyId,
	            manualHitShapeId,
	            manualHitBodyType,
	            manualHitChunkKey,
	            manualHitDistance,
	            manualHitPointY,
	            manualHitNormalY,
	            manualHitBodyPos,
	            wheelConnLat: wheelConnLatLon?.lat ?? null,
	            wheelConnLon: wheelConnLatLon?.lon ?? null,
	            wheelConnChunkKey,
	            wheelConnChunkState,
	            wheelConnChunkBodyId,
	            wheelY: wheelPos?.y ?? null,
	            wheelLat: wheelLatLon?.lat ?? null,
	            wheelLon: wheelLatLon?.lon ?? null,
	            wheelTerrainHeight,
	            wheelGapMeters:
	              wheelTerrainHeight !== null && wheelPos?.y !== undefined
	                ? (wheelPos.y * travelScale - wheelTerrainHeight)
	                : null,
	          };
	        });
	        console.log("[drive] wheel contact diagnostics", {
	          heightGap,
	          maxRayLength: maxRay,
	          maxRayMeters,
	          suspensionRestLength: wheelInfos[0]?.suspensionRestLength ?? null,
	          maxSuspensionTravel: wheelInfos[0]?.maxSuspensionTravel ?? null,
	          wheelRadius: wheelInfos[0]?.radius ?? null,
	          wheels: perWheel,
	        });
	        if (captureEvents) {
	          pushTerrainEvent("wheel-contact-diagnostics", {
	            heightGap,
	            maxRayLength: maxRay,
	            maxRayMeters,
	            chunkKey: carChunkKey,
	            wheels: perWheel.map((w) => ({
	              index: w.index,
	              hasHit: w.hasHit,
	              hitBodyType: w.hitBodyType,
	              hitChunkKey: w.hitChunkKey,
	              manualHasHit: w.manualHasHit,
	              manualHitBodyType: w.manualHitBodyType,
	              manualHitChunkKey: w.manualHitChunkKey,
	              wheelConnChunkKey: w.wheelConnChunkKey,
	              wheelConnChunkState: w.wheelConnChunkState,
	              wheelGapMeters: w.wheelGapMeters,
	              computedRayLenMeters: w.computedRayLenMeters,
	              rayLenMeters: w.rayLenMeters,
	            })),
	          });
	        }
	      }
	    }
    if (wheelsOnGround === 0) {
      animate.noGroundSince = animate.noGroundSince ?? now;
    } else {
      animate.noGroundSince = null;
    }
    const noGroundTooLong =
      SAFETY_PLANE_MS > 0 && animate.noGroundSince && now - animate.noGroundSince > SAFETY_PLANE_MS;
    const shouldUsePlane =
      !cogTerrainEnabled || !physicsTerrainReady || missingTerrainHeight || noGroundTooLong;

    const fallbackHeight = Number.isFinite(terrainHeight)
      ? terrainHeight
      : Number.isFinite(cachedTerrainHeight)
        ? cachedTerrainHeight
        : null;
    const fallbackY =
      Number.isFinite(fallbackHeight) && fallbackHeight !== 0
        ? fallbackHeight / travelScale
        : 0;

    const groundInWorldBefore = world.bodies.includes(groundBody);
    if (captureEvents) {
      const key = `${shouldUsePlane}:${groundInWorldBefore}:${missingTerrainHeight}:${noGroundTooLong}:${physicsTerrainReady}`;
      if (key !== animate.lastPlaneEventKey) {
        animate.lastPlaneEventKey = key;
        pushTerrainEvent("safety-plane-eval", {
          shouldUsePlane,
          groundInWorld: groundInWorldBefore,
          cogTerrainEnabled,
          physicsTerrainReady,
          missingTerrainHeight,
          noGroundTooLong,
          safetyPlaneMs: SAFETY_PLANE_MS,
          terrainHeight,
          cachedTerrainHeight,
        });
      }
    }
    if (shouldUsePlane) {
      if (animate.planeBlend) animate.planeBlend = null;
      if (!world.bodies.includes(groundBody)) {
        world.addBody(groundBody);
        terrainLog("ground plane add", { reason: "shouldUsePlane" });
        if (captureEvents) pushTerrainEvent("ground-plane-add", { reason: "shouldUsePlane" });
      }
      const prevPlaneHeight = groundBody.position.y * travelScale;
      groundBody.position.y = fallbackY;
      groundBody.quaternion.copy(baseGroundQuat);
      const nextPlaneHeight = groundBody.position.y * travelScale;
      const planeDelta = nextPlaneHeight - prevPlaneHeight;
      if (captureEvents && Number.isFinite(planeDelta) && Math.abs(planeDelta) > 2) {
        terrainLog("ground plane height change", {
          prevPlaneHeight,
          nextPlaneHeight,
          delta: planeDelta,
          terrainHeight,
          cachedTerrainHeight,
          missingTerrainHeight,
          noGroundTooLong,
        });
        pushTerrainEvent("ground-plane-height-change", {
          prevPlaneHeight,
          nextPlaneHeight,
          delta: planeDelta,
          terrainHeight,
          cachedTerrainHeight,
          missingTerrainHeight,
          noGroundTooLong,
        });
      }
    } else {
      const groundInWorld = world.bodies.includes(groundBody);
      const carHeightMeters = chassisBody ? chassisBody.position.y * travelScale : null;
      const planeHeightMeters = groundBody.position.y * travelScale;
      const heightDelta = Number.isFinite(fallbackHeight)
        ? Math.abs(fallbackHeight - planeHeightMeters)
        : null;
      const planeBelowCar =
        Number.isFinite(carHeightMeters) && planeHeightMeters <= carHeightMeters + 0.5;
      const canBlend =
        groundInWorld
        && PLANE_BLEND_MS > 0
        && Number.isFinite(fallbackHeight)
        && planeBelowCar
        && Number.isFinite(heightDelta)
        && heightDelta <= PLANE_BLEND_MAX_DELTA;

      if (canBlend) {
        if (!animate.planeBlend) {
          animate.planeBlend = {
            startAt: now,
            endAt: now + PLANE_BLEND_MS,
            startHeight: planeHeightMeters,
            targetHeight: fallbackHeight,
          };
          terrainLog("ground plane blend start", {
            startHeight: animate.planeBlend.startHeight,
            targetHeight: animate.planeBlend.targetHeight,
          });
          if (captureEvents) {
            pushTerrainEvent("ground-plane-blend-start", {
              startHeight: animate.planeBlend.startHeight,
              targetHeight: animate.planeBlend.targetHeight,
            });
          }
        }
      } else {
        animate.planeBlend = null;
      }

      if (animate.planeBlend) {
        const blend = animate.planeBlend;
        const duration = Math.max(1, blend.endAt - blend.startAt);
        const t = clamp((now - blend.startAt) / duration, 0, 1);
        const blendedHeight = blend.startHeight + (blend.targetHeight - blend.startHeight) * t;
        if (!world.bodies.includes(groundBody)) {
          world.addBody(groundBody);
          terrainLog("ground plane add", { reason: "blend" });
          if (captureEvents) pushTerrainEvent("ground-plane-add", { reason: "blend" });
        }
        groundBody.position.y = blendedHeight / travelScale;
        groundBody.quaternion.copy(baseGroundQuat);
        if (t >= 1) {
          world.removeBody(groundBody);
          terrainLog("ground plane remove", { reason: "blend-complete" });
          if (captureEvents) {
            pushTerrainEvent("ground-plane-remove", { reason: "blend-complete" });
          }
          animate.planeBlend = null;
        }
      } else if (world.bodies.includes(groundBody)) {
        world.removeBody(groundBody);
        terrainLog("ground plane remove", { reason: "terrain-ready" });
        if (captureEvents) pushTerrainEvent("ground-plane-remove", { reason: "terrain-ready" });
      }
    }
    if (logTerrain && chassisBody) {
      const groundInWorld = world.bodies.includes(groundBody);
      const stateKey = `${shouldUsePlane ? "plane" : "terrain"}:${physicsTerrainReady ? "ready" : "not-ready"}:${groundInWorld ? "ground-on" : "ground-off"}`;
      if (stateKey !== animate.lastTerrainStateKey || now - (animate.lastTerrainStateLogAt ?? 0) > 2000) {
        animate.lastTerrainStateKey = stateKey;
        animate.lastTerrainStateLogAt = now;
        console.log("[drive] terrain mode", {
          mode: shouldUsePlane ? "plane" : "terrain",
          physicsTerrainReady,
          groundInWorld,
          terrainHeight,
          missingTerrainHeight,
          noGroundTooLong,
          safetyPlaneMs: SAFETY_PLANE_MS,
          cachedTerrainHeight,
          terrainHeightValid,
          carHeight: chassisBody.position.y * travelScale,
          wheelsOnGround,
          chunkKey: physicsTerrain?.keyForLatLon?.(carLat, carLon) ?? null,
        });
      }
      if (wheelsOnGround === 0 && !shouldUsePlane) {
        if (!animate.lastNoGroundLogAt || now - animate.lastNoGroundLogAt > 1000) {
          animate.lastNoGroundLogAt = now;
          console.warn("[drive] wheels=0 on terrain", {
            carHeight: chassisBody.position.y * travelScale,
            terrainHeight,
            physicsTerrainReady,
            chunkKey: physicsTerrain?.keyForLatLon?.(carLat, carLon) ?? null,
          });
        }
      }
    }
    if (tileStream) {
      updateStreamTiles(carLat, carLon);
    } else {
      for (const layer of tileLayers) {
        const now = performance.now();
        const level = layer.level;
        const center = tileXYFromLatLon(level, carLat, carLon);
        const centerKey = `${center.x}:${center.y}`;
        if (freezeTiles && layer.lastCenterKey !== null) {
          if (!layer.freezeLogged) {
            imageryLog("imagery refresh frozen", { level });
            layer.freezeLogged = true;
          }
          continue;
        }
        const prevCenterKey = layer.lastCenterKey;
        const prevUpdateAt = layer.lastUpdateAt ?? 0;
        const centerChanged = centerKey !== prevCenterKey;
        const timedOut = tileRefreshMs > 0 && now - prevUpdateAt > tileRefreshMs;
        const shouldUpdate = centerChanged || timedOut;
        if (!shouldUpdate) continue;
        layer.lastCenterKey = centerKey;
        layer.lastUpdateAt = now;

        const layerRadius = layer.isBase ? gridRadius : clamp(gridRadius - (TILE_LEVEL - level), 1, gridRadius);

        if (layer.persistTiles) {
          let requested = 0;
          let created = 0;
          let newUrl = 0;
          for (let row = -layerRadius; row <= layerRadius; row += 1) {
            for (let col = -layerRadius; col <= layerRadius; col += 1) {
              let tileX = center.x + col;
              let tileY = center.y + row;

              tileX = ((tileX % layer.xTiles) + layer.xTiles) % layer.xTiles;
              tileY = clamp(tileY, 0, layer.yTiles - 1);

              const bounds = tileBounds(level, tileX, tileY);
              const tileCenterLat = (bounds.north + bounds.south) / 2;
              const tileCenterLon = (bounds.west + bounds.east) / 2;
              const meters = latLonToLocalMeters(tileCenterLat, tileCenterLon);

              const tileKey = `${tileX}:${tileY}`;
              let mesh = layer.persistTiles.get(tileKey);
              if (!mesh) {
                mesh = createPersistTileMesh(layer, tileX, tileY);
                tileGroup.add(mesh);
                layer.meshes.push(mesh);
                layer.persistTiles.set(tileKey, mesh);
                created += 1;
              }

              mesh.position.x = meters.x * WORLD_TO_RENDER;
              mesh.position.z = meters.z * WORLD_TO_RENDER;
              mesh.userData.tileX = tileX;
              mesh.userData.tileY = tileY;

              const url = `${PROXY_BASE_PATH}/${level}/${tileX}/${tileY}.jpg`;
              if (mesh.material.map) {
                mesh.visible = true;
              } else {
                mesh.visible = layer.isBase || level10Only;
              }
              if (mesh.userData.url !== url) newUrl += 1;
              requestTileTexture(mesh, url, bounds);
              requested += 1;
            }
          }

          if (logTerrain) {
            console.log("[drive] tile refresh", {
              level,
              centerKey,
              reason: centerChanged ? "center-change" : "timer",
              refreshMs: tileRefreshMs,
              gridRadius,
              layerRadius,
              requested,
              newUrl,
              created,
              tiles: layer.persistTiles.size,
            });
            if (captureEvents && (eventVerbose || centerChanged)) {
              pushTerrainEvent("tile-refresh", {
                level,
                centerKey,
                reason: centerChanged ? "center-change" : "timer",
                gridRadius,
                layerRadius,
                requested,
                newUrl,
                created,
                tiles: layer.persistTiles.size,
              });
            }
          }
          continue;
        }

        let meshIndex = 0;
        let requested = 0;
        let newUrl = 0;
        let inBandCount = 0;
        let hidden = 0;
        for (let row = -gridRadius; row <= gridRadius; row += 1) {
          for (let col = -gridRadius; col <= gridRadius; col += 1) {
            let tileX = center.x + col;
            let tileY = center.y + row;

            tileX = ((tileX % layer.xTiles) + layer.xTiles) % layer.xTiles;
            tileY = clamp(tileY, 0, layer.yTiles - 1);

            const bounds = tileBounds(level, tileX, tileY);
            const tileCenterLat = (bounds.north + bounds.south) / 2;
            const tileCenterLon = (bounds.west + bounds.east) / 2;
            const meters = latLonToLocalMeters(tileCenterLat, tileCenterLon);

            const mesh = layer.meshes[meshIndex];
            mesh.position.x = meters.x * WORLD_TO_RENDER;
            mesh.position.z = meters.z * WORLD_TO_RENDER;
            mesh.userData.tileX = tileX;
            mesh.userData.tileY = tileY;

            const inBand = Math.abs(row) <= layerRadius && Math.abs(col) <= layerRadius;
            if (!inBand) {
              mesh.visible = false;
              hidden += 1;
              meshIndex += 1;
              continue;
            }
            inBandCount += 1;

            const url = `${PROXY_BASE_PATH}/${level}/${tileX}/${tileY}.jpg`;
            if (mesh.material.map) {
              mesh.visible = true;
            } else {
              mesh.visible = layer.isBase || level10Only;
            }
            if (mesh.userData.url !== url) newUrl += 1;
            requestTileTexture(mesh, url, bounds);
            requested += 1;

            meshIndex += 1;
          }
        }
        if (logTerrain) {
          console.log("[drive] tile refresh", {
            level,
            centerKey,
            reason: centerChanged ? "center-change" : "timer",
            refreshMs: tileRefreshMs,
            gridRadius,
            layerRadius,
            requested,
            newUrl,
            inBand: inBandCount,
            hidden,
          });
          if (captureEvents && (eventVerbose || centerChanged)) {
            pushTerrainEvent("tile-refresh", {
              level,
              centerKey,
              reason: centerChanged ? "center-change" : "timer",
              gridRadius,
              layerRadius,
              requested,
              newUrl,
              hidden,
            });
          }
        }
      }
    }

    // Add lateral camera offset when steering to show the car from the side
    const steerCameraOffset = steer * 3.0; // Moves camera sideways based on steering
    const dynamicCameraOffset = cameraOffset.clone();
    dynamicCameraOffset.x += steerCameraOffset; // Shift camera left/right

    // Use yaw-only rotation to avoid camera jitter from suspension pitch/roll.
    yawEuler.setFromQuaternion(carRoot.quaternion, "YXZ");
    yawQuat.setFromAxisAngle(yawAxis, yawEuler.y);
    const idealOffset = dynamicCameraOffset
      .clone()
      .multiplyScalar(zoomFactor)
      .applyQuaternion(yawQuat)
      .add(carRoot.position);
    camera.position.lerp(idealOffset, 0.05); // More smoothing (less jitter), slightly more lag

    // Look slightly ahead of the car based on steering
    const lookTarget = carRoot.position.clone().add(lookOffset);
    camera.lookAt(lookTarget);


    speedEl.textContent = `${speed.toFixed(1)} m/s`;
    if (gearEl) {
      gearEl.textContent = controls.backward ? "R" : "D";
    }
    coordsEl.textContent = `${carLat.toFixed(3)}, ${carLon.toFixed(3)}`;
    if (inputEl) {
      const activeInputs = [];
      if (controls.forward) activeInputs.push("W/↑");
      if (controls.backward) activeInputs.push("S/↓");
      if (controls.left) activeInputs.push("A/←");
      if (controls.right) activeInputs.push("D/→");
      if (controls.brake) activeInputs.push("Space");
      const label = activeInputs.length ? activeInputs.join(" ") : "-";
      inputEl.textContent = `${label} · wheels ${wheelsOnGround}`;
    }

    renderer.render(scene, camera);
  }

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  animate();
}

main().catch((err) => {
  console.error(err);
  setStatus("Failed to load. See console.");
});
