# setup.ps1 — One-time initialization for the transit tracker stack (Windows PowerShell)
# Downloads static geometry, builds the map UI, validates the environment.
#
# Usage (in PowerShell):
#   .\setup.ps1          # Full setup
#   .\setup.ps1 -Help    # Show options
#   .\setup.ps1 -ValidateOnly  # Just check setup
#
# Note: On first run, you may need to enable script execution:
#   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

param(
  [switch]$SkipElevation,
  [switch]$ValidateOnly,
  [switch]$Clean,
  [switch]$Help
)

# Color helpers
function Write-Info { Write-Host "[INFO] $args" -ForegroundColor Cyan }
function Write-Success { Write-Host "[OK] $args" -ForegroundColor Green }
function Write-Warn { Write-Host "[WARN] $args" -ForegroundColor Yellow }
function Write-Err { Write-Host "[ERROR] $args" -ForegroundColor Red }

# Check for Docker
function Check-Docker {
  try {
    $version = docker --version 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Docker not found" }
    Write-Success "Docker found: $version"
    return $true
  }
  catch {
    Write-Err "Docker is not installed. Visit https://docs.docker.com/get-docker/"
    return $false
  }
}

# Check for Docker Compose
function Check-DockerCompose {
  try {
    $version = docker compose version 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose not found" }
    Write-Success "Docker Compose found: $($version[0])"
    return $true
  }
  catch {
    Write-Err "Docker Compose is not available. Update Docker Desktop."
    return $false
  }
}

# Build train_3d_map image
function Build-TrainService {
  Write-Info "Building train_3d_map image..."
  docker compose build train_3d_map
  if ($LASTEXITCODE -ne 0) {
    Write-Err "Failed to build train_3d_map"
    return $false
  }
  Write-Success "train_3d_map image built"
  return $true
}

# Download NYC static geometry
function Preprocess-NYC {
  Write-Info "Downloading NYC subway geometry (shapes + stops)..."
  docker compose run --rm train_3d_map npm run preprocess:nyc
  if ($LASTEXITCODE -ne 0) {
    Write-Err "Failed to preprocess NYC data"
    return $false
  }
  Write-Success "NYC geometry downloaded to ./data/nyc/"
  return $true
}

# Download elevation data (optional)
function Preprocess-OSM {
  Write-Warn "Elevation data is optional (slower, but nice)."
  $response = Read-Host "Download elevation layers? (y/n)"

  if ($response -match '^[Yy]$') {
    Write-Info "Downloading OSM elevation data..."
    docker compose run --rm train_3d_map npm run preprocess:osm-layers
    if ($LASTEXITCODE -ne 0) {
      Write-Err "Failed to download OSM layers"
      return $false
    }
    docker compose run --rm train_3d_map npm run preprocess:osm-match
    if ($LASTEXITCODE -ne 0) {
      Write-Err "Failed to match OSM data"
      return $false
    }
    Write-Success "Elevation data downloaded"
  }
  else {
    Write-Warn "Skipped elevation data (map will work without it)"
  }
  return $true
}

# Build the map UI
function Build-WebUI {
  Write-Info "Building map UI (Vite + deck.gl)..."
  docker run --rm -v "${PWD}:/repo" -w /repo/web node:24-slim sh -c "npm ci; npm run build"
  if ($LASTEXITCODE -ne 0) {
    Write-Err "Failed to build map UI"
    return $false
  }
  Write-Success "Map UI built to ./web/dist"
  return $true
}

# Validate setup
function Validate-Setup {
  Write-Info "Validating setup..."
  $valid = $true

  if (-not (Test-Path "./data/nyc")) {
    Write-Err "NYC geometry missing. Run: docker compose run --rm train_3d_map npm run preprocess:nyc"
    $valid = $false
  }

  if (-not (Test-Path "./web/dist")) {
    Write-Err "Map UI missing. Run: docker run --rm -v PWD\web:/w -w /w node:24-slim sh -c npm ci; npm run build"
    $valid = $false
  }

  docker compose config -q 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Err "docker-compose.yml validation failed"
    $valid = $false
  }

  if ($valid) {
    Write-Success "All setup checks passed"
  }
  return $valid
}

# Show help
function Show-Help {
  Write-Host ""
  Write-Host "Usage: .\setup.ps1 [OPTIONS]"
  Write-Host ""
  Write-Host "One-time initialization for the transit tracker stack."
  Write-Host ""
  Write-Host "OPTIONS:"
  Write-Host "  -Help              Show this help message"
  Write-Host "  -SkipElevation     Skip downloading optional elevation data"
  Write-Host "  -ValidateOnly      Just validate the setup"
  Write-Host "  -Clean             Remove data/ and web/dist before rebuilding"
  Write-Host ""
  Write-Host "WHAT IT DOES:"
  Write-Host "  1. Checks for Docker and Docker Compose"
  Write-Host "  2. Builds the train_3d_map container image"
  Write-Host "  3. Downloads NYC subway geometry (required, ~10 seconds)"
  Write-Host "  4. Optionally downloads elevation layers"
  Write-Host "  5. Builds the map UI (Vite + deck.gl)"
  Write-Host "  6. Validates everything is ready"
  Write-Host ""
  Write-Host "AFTER SETUP:"
  Write-Host "  docker compose up --build"
  Write-Host ""
  Write-Host "Then visit:"
  Write-Host "  - Map: http://localhost:8088"
  Write-Host "  - Dashboard: http://localhost:4174"
  Write-Host ""
  Write-Host "For more info, see DEPLOY.md or README.md"
  Write-Host ""
}

# Main
function Main {
  Write-Host ""
  Write-Info "Transit Tracker Setup"
  Write-Host ""

  if ($Help) {
    Show-Help
    return
  }

  # Check dependencies
  if (-not (Check-Docker)) { exit 1 }
  if (-not (Check-DockerCompose)) { exit 1 }
  Write-Host ""

  # Clean if requested
  if ($Clean) {
    Write-Warn "Cleaning data/ and web/dist..."
    if (Test-Path "./data") { Remove-Item -Recurse -Force "./data" }
    if (Test-Path "./web/dist") { Remove-Item -Recurse -Force "./web/dist" }
    Write-Success "Cleaned"
    Write-Host ""
  }

  # Validate-only mode
  if ($ValidateOnly) {
    if (Validate-Setup) {
      Write-Host ""
      Write-Success "Ready to run: docker compose up --build"
    }
    else {
      exit 1
    }
    return
  }

  # Build and download
  if (-not (Build-TrainService)) { exit 1 }
  Write-Host ""

  if (-not (Preprocess-NYC)) { exit 1 }
  Write-Host ""

  if (-not $SkipElevation) {
    if (-not (Preprocess-OSM)) { exit 1 }
  }
  else {
    Write-Warn "Skipped elevation data (-SkipElevation)"
  }
  Write-Host ""

  if (-not (Build-WebUI)) { exit 1 }
  Write-Host ""

  # Validate final state
  if (Validate-Setup) {
    Write-Host ""
    Write-Success "Setup complete!"
    Write-Host ""
    Write-Info "Next step:"
    Write-Host "  docker compose up --build"
    Write-Host ""
    Write-Info "Then visit:"
    Write-Host "  Map:       http://localhost:8088"
    Write-Host "  Dashboard: http://localhost:4174"
    Write-Host ""
  }
  else {
    Write-Err "Setup validation failed"
    exit 1
  }
}

Main
