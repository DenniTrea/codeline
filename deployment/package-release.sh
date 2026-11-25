#!/usr/bin/env bash
set -euo pipefail
project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
release_dir=${1:-/tmp/codeline-release}
mkdir -p -- "$release_dir"
release_dir=$(cd -- "$release_dir" && pwd)
cd -- "$project_root"
npm run typecheck -w backend
npm run typecheck -w frontend
npm test
npm run build
release_file="$release_dir/codeline-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -czf "$release_file" -- \
  package.json package-lock.json \
  backend/package.json backend/dist/src \
  frontend/package.json frontend/dist \
  deployment/codeline.service deployment/nginx.conf \
  deployment/backend.env.example deployment/DEPLOYMENT.txt
printf 'Release archive: %s\n' "$release_file"
printf 'Contains built application and templates; no environment credentials or database migrations.\n'
