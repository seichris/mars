# view-mars

View `MarsTopo7mRelief.kml` (a KML super-overlay descriptor) in a browser using CesiumJS.

## Run locally

1. Start the included dev server + tile proxy:

   `node server.js`

2. Open `http://localhost:8000/` in your browser (or the port you passed as an arg).

Notes:
- Opening `index.html` directly from disk (`file://...`) won’t work reliably due to browser CORS rules.
- The upstream tile host referenced by the KML does not send CORS headers, so the included server proxies tiles at `/tiles/...` to make CesiumJS loading work in a browser.
- `main.js` reads `MarsTopo7mRelief.kml`, extracts the tile host URL, and loads the `/{z}/{x}/{y}.jpg` tile pyramid via the proxy when available.

## Deploy on Coolify (Docker)

This repo includes a `Dockerfile` that runs the tile proxy + static site.

1. Create a new app in Coolify and select “Dockerfile”.
2. Set the build context to the repo root.
3. Expose port `8000` (or set `PORT` to another value and match it in Coolify).
4. Deploy, then visit the app URL.

## Docker Compose (with Nginx cache)

For a VPS, you can use the provided compose + Nginx cache:

1. `docker compose up --build -d`
2. Open `http://localhost:8000/`

Notes:
- Nginx caches `/tiles/...` responses for 7 days and adds `X-Cache-Status` headers.
- The app container only exposes port `8000` internally; Nginx publishes `8000` on the host.

## Debugging a blue globe

If you see only a blue globe, it usually means tiles are not loading.

Try:
- Add `?debug=1` to the URL and open the browser console. The app logs the tile host, a sample tile check, and tile load counts.
- Ensure you started the proxy server (`node server.js`) and see `Using local tile proxy (/tiles).` on the HUD.
- Run with logs: `LOG_TILES=1 node server.js` to print tile proxy requests and response codes.
