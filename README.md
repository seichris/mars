# Drive Cybertruck on Mars

Drive a Cybertruck on Mars, using Three.js + Cannon‑ES.

## Terrain Data

For imagery data, we use [Casey Handmer's highest res Mars map ever](https://x.com/CJHandmer/status/2015612445554090440). Thanks for building and hosting!

For terrain data we currently use this dataset: https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m

And to limit download size, we generated a cutout for the Valles Marineris + Tharsis region with:

```bash
gdalwarp -of GTiff \
  -te 180 -55 360 55 \
  -r bilinear \
  -co COMPRESS=LZW \
  -co TILED=YES \
  -co BIGTIFF=YES \
  -overwrite \
  Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif \
  assets/mars_valles_tharsis_200m.tif
```

## Run Locally

1. Start the server:

   `node server.js`

2. Open:

   `http://localhost:8000/` (Drive view)

Optional: `http://localhost:8000/map` opens the Cesium globe viewer.

## Car Physics

The car uses `cannon-es` with a `RaycastVehicle` chassis + wheels. The chassis is a compound body (main box + thin skid plate) for stability. The wheel suspension and steering are tuned in `drive.js`, and the physics world runs with a fixed timestep.

Key files:
- `drive.js` (physics + vehicle setup)
- `car_physics.md` (detailed tuning notes)

### Core Physics Settings (drive.js)

World settings:
- `PHYSICS_FIXED_TIMESTEP` and `PHYSICS_MAX_SUBSTEPS` (stability vs perf)
- Gravity: `world.gravity = (0, -3.711, 0)` (Mars)
- Solver/contact tuning: `world.solver.iterations`, contact stiffness/relaxation

Vehicle settings:
- `buildVehicle(...)`: chassis sizes, skid plate extents, wheel radius, suspension rest length
- `VEHICLE_CONFIG`: steering response, damping, drive type (AWD/FWD/RWD), brake bias
- `TIRE_CONFIG`: rolling resistance

Scaling:
- `travelScale` matches the visual car scale and converts physics units ↔ meters.
- Physics shapes remain at base size; visual scale is applied to the car model.

### Terrain Physics (COG heightmap)

Physics terrain is built from a COG heightmap into `cannon-es` Trimesh chunks.

URL params (override defaults):
- `pchunk` (meters per physics chunk, default `400`)
- `pseg` (segments per chunk edge, default depends on car scale; usually `6`)
- `pradius` (chunk radius around car, default `4`)
- `pprefetch` (startup prefetch radius, default `12`)
- `pahead` (forward prefetch radius when moving, default `pradius + 2`)
- `origin` (floating origin threshold in meters, default `1200`)

Notes:
- Larger `pradius` loads more chunks (fewer gaps, more CPU/memory).
- Larger `pchunk` reduces chunk count but lowers detail unless you also raise `pseg`.
- Smaller `pseg` is faster but creates “steppy” terrain.
- Floating-origin shifts move all physics bodies; `drive.js` forces AABB updates so wheel raycasts keep hitting terrain.

### Visual Tile LOD

By default we render only the highest imagery level (equivalent to `?level10Only=1`) to avoid multi-LOD stacking artifacts.
To re-enable multi-LOD rendering: `?level10Only=0&lod=4`.

### Debugging

Enable physics debug overlays:
- `?debug=1&debugPhysics=1` shows `cannon-es` wireframes (green) and the active terrain chunk (cyan).
- `?wheels=1` shows wheel meshes.

Logs include wheel ray hits, chunk readiness, and “car below terrain” warnings.
For high-signal event dumps around failures: `?debugEvents=1&eventDump=120&eventBuf=1200&eventVerbose=1`.

## Deploy with Docker

This repo includes a `Dockerfile` that runs `server.js` and serves the Cybertruck experience.

1. Build:

   `docker build -t drive-mars .`

2. Run:

   `docker run --rm -p 8000:8000 drive-mars`

3. Open:

   `http://localhost:8000/`

## Credits

Cybertruck model: https://sketchfab.com/3d-models/teslas-cyber-truck-low-poly-d577ffc486f447bab41380a57caa7435

## Roadmap

- More fun car physics
- [Terraform Mars and sail a boat on its lakes](https://caseyhandmer.wordpress.com/2022/07/12/how-to-terraform-mars-for-10b-in-10-years/)
- Actually using CJHandmer's terrain data, additionally to the imagery tiles
