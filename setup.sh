#!/bin/bash
# setup.sh — One-time initialization for the transit tracker stack
# Downloads static geometry, builds the map UI, validates the environment.
#
# Usage:
#   ./setup.sh          # Full setup
#   ./setup.sh --help   # Show options

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
  echo -e "${GREEN}✅ $1${NC}"
}

log_warn() {
  echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
  echo -e "${RED}❌ $1${NC}"
}

# Check for Docker
check_docker() {
  if ! command -v docker &> /dev/null; then
    log_error "Docker is not installed. Visit https://docs.docker.com/get-docker/"
    exit 1
  fi
  log_success "Docker found: $(docker --version)"
}

# Check for Docker Compose
check_docker_compose() {
  if ! docker compose version &> /dev/null; then
    log_error "Docker Compose is not available. Update Docker Desktop or install Docker Compose."
    exit 1
  fi
  log_success "Docker Compose found: $(docker compose version | head -1)"
}

# Build train_3d_map image
build_train_service() {
  log_info "Building train_3d_map image..."
  docker compose build train_3d_map
  log_success "train_3d_map image built"
}

# Download NYC static geometry
preprocess_nyc() {
  log_info "Downloading NYC subway geometry (shapes + stops)..."
  docker compose run --rm train_3d_map npm run preprocess:nyc
  log_success "NYC geometry downloaded to ./data/nyc/"
}

# Download elevation data (optional)
preprocess_osm() {
  log_warn "Elevation data is optional (nice-to-have, slower)."
  read -p "Download elevation layers? (y/n) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    log_info "Downloading OSM elevation data..."
    docker compose run --rm train_3d_map npm run preprocess:osm-layers
    docker compose run --rm train_3d_map npm run preprocess:osm-match
    log_success "Elevation data downloaded"
  else
    log_warn "Skipped elevation data (map will work without it)"
  fi
}

# Build the map UI
build_web_ui() {
  log_info "Building map UI (Vite + deck.gl)..."
  docker run --rm -v "$PWD":/repo -w /repo/web node:24-slim sh -c "npm ci && npm run build"
  log_success "Map UI built to ./web/dist"
}

# Validate setup
validate_setup() {
  log_info "Validating setup..."

  if [ ! -d "./data/nyc" ]; then
    log_error "NYC geometry missing. Run: docker compose run --rm train_3d_map npm run preprocess:nyc"
    return 1
  fi

  if [ ! -d "./web/dist" ]; then
    log_error "Map UI missing. Run: docker run --rm -v \"\$PWD\":/repo -w /repo/web node:24-slim sh -c \"npm ci && npm run build\""
    return 1
  fi

  if ! docker compose config -q 2>/dev/null; then
    log_error "docker-compose.yml validation failed"
    return 1
  fi

  log_success "All setup checks passed"
  return 0
}

# Show help
show_help() {
  cat << EOF
Usage: ./setup.sh [OPTIONS]

One-time initialization for the transit tracker stack.

OPTIONS:
  --help              Show this help message
  --skip-elevation    Skip downloading optional elevation data
  --validate-only     Just validate the setup (don't download/build)
  --clean             Remove data/ and web/dist before rebuilding

WHAT IT DOES:
  1. Checks for Docker and Docker Compose
  2. Builds the train_3d_map container image
  3. Downloads NYC subway geometry (required, ~10 seconds)
  4. Optionally downloads elevation layers
  5. Builds the map UI (Vite + deck.gl)
  6. Validates everything is ready

AFTER SETUP:
  docker compose up --build

Then visit:
  - Map: http://localhost:8088
  - Dashboard: http://localhost:4174

For more info, see DEPLOY.md or README.md
EOF
}

# Parse arguments
SKIP_ELEVATION=false
VALIDATE_ONLY=false
CLEAN=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --help)
      show_help
      exit 0
      ;;
    --skip-elevation)
      SKIP_ELEVATION=true
      shift
      ;;
    --validate-only)
      VALIDATE_ONLY=true
      shift
      ;;
    --clean)
      CLEAN=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      show_help
      exit 1
      ;;
  esac
done

# Main execution
main() {
  echo ""
  log_info "🚀 Transit Tracker Setup"
  echo ""

  check_docker
  check_docker_compose
  echo ""

  if [ "$CLEAN" = true ]; then
    log_warn "Cleaning data/ and web/dist..."
    rm -rf data web/dist
    log_success "Cleaned"
    echo ""
  fi

  if [ "$VALIDATE_ONLY" = true ]; then
    if validate_setup; then
      echo ""
      log_success "Ready to run: docker compose up --build"
    else
      exit 1
    fi
    return
  fi

  build_train_service
  echo ""

  preprocess_nyc
  echo ""

  if [ "$SKIP_ELEVATION" = false ]; then
    preprocess_osm
  else
    log_warn "Skipped elevation data (--skip-elevation)"
  fi
  echo ""

  build_web_ui
  echo ""

  if validate_setup; then
    echo ""
    log_success "Setup complete! 🎉"
    echo ""
    log_info "Next step:"
    echo "  docker compose up --build"
    echo ""
    log_info "Then visit:"
    echo "  Map:       http://localhost:8088"
    echo "  Dashboard: http://localhost:4174"
    echo ""
  else
    log_error "Setup validation failed"
    exit 1
  fi
}

main
