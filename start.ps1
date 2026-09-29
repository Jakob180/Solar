$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath 'backend/.venv/Scripts/python.exe') -or -not (Test-Path -LiteralPath 'frontend/node_modules')) {
    npm run setup
}

npm --prefix frontend run build
node scripts/dev.mjs --preview

