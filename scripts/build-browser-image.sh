#!/usr/bin/env bash
set -euo pipefail

# Builds the Chromium-only browser sidecar image once. Chats never download a
# browser; they start containers from this image.

image="${BROWSER_IMAGE:-aitar-browser:chromium}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker build --tag "$image" --file "$root/docker/browser/Dockerfile" "$root/docker/browser"

printf '\nBuilt %s\n' "$image"
docker image inspect "$image" --format 'unpacked size: {{.Size}} bytes'
