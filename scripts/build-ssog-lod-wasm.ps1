$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$crateDir = Join-Path $repoRoot "wasm\ssog_lod_traversal"
$outDir = Join-Path $repoRoot "src\wasm\ssog_lod_traversal_pkg"

if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
  throw "rustc was not found. Install Rust with rustup before running this script."
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw "cargo was not found. Install Rust with rustup before running this script."
}

if (-not (Get-Command wasm-pack -ErrorAction SilentlyContinue)) {
  throw "wasm-pack was not found. Install it with: cargo install wasm-pack"
}

Push-Location $crateDir
try {
  wasm-pack build --target web --out-dir $outDir --release
} finally {
  Pop-Location
}
