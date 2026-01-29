#!/usr/bin/env bash
# Final build script for TravelGrid:
# - Installs dependencies
# - Builds Vite frontend into ./public
# - Bundles Cloudflare Worker to ./dist/worker/index.js with esbuild
set -euo pipefail
set -x

# -- Helpers ---------------------------------------------------------------
exists() { [ -f "$1" ]; }

info() { echo "==> $*"; }

# -- Install dependencies --------------------------------------------------
info "Installing dependencies"
if exists package-lock.json; then
  npm ci
elif exists pnpm-lock.yaml; then
  pnpm install --frozen-lockfile
elif exists yarn.lock; then
  yarn install --frozen-lockfile
else
  # Fallback to npm install if no lockfile exists
  npm install
fi

# -- Build frontend -------------------------------------------------------
# Prefer explicit scripts if provided: build:client > build > vite build
info "Building frontend (Vite)"
if npm run | grep -q "build:client"; then
  npm run build:client
elif npm run | grep -q "\"build\""; then
  # run generic build if user has configured it (may also build worker - that's ok)
  npm run build
else
  # fallback to direct vite build (npx will run it from node_modules if present)
  npx vite build
fi

# Ensure public directory exists (vite should create it)
if [ ! -d ./public ]; then
  echo "Warning: ./public directory not found after frontend build. Check Vite config outDir."
fi

# -- Build worker ---------------------------------------------------------
info "Bundling worker"

# Determine entrypoint (prefer src/worker/index.{ts,js})
ENTRY=""
if exists "src/worker/index.ts"; then
  ENTRY="src/worker/index.ts"
elif exists "src/worker/index.js"; then
  ENTRY="src/worker/index.js"
elif exists "src/index.ts"; then
  ENTRY="src/index.ts"
elif exists "src/index.js"; then
  ENTRY="src/index.js"
fi

if [ -z "$ENTRY" ]; then
  echo "Error: No worker entrypoint found (looked for src/worker/index.{ts,js} and src/index.{ts,js})"
  exit 1
fi

mkdir -p dist/worker

# Use esbuild to produce a module-format bundle suitable for Wrangler
# --platform=neutral to avoid Node polyfills; adjust target if needed
npx esbuild "$ENTRY" \
  --bundle \
  --target=es2022 \
  --format=esm \
  --outfile=dist/worker/index.js \
  --platform=neutral \
  --define:process.env.NODE_ENV=\"production\"

# -- Post build checks ---------------------------------------------------
info "Build complete. Artifacts:"
ls -la ./public || true
ls -la ./dist/worker || true

echo "Done"
