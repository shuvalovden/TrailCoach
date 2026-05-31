# TrailCoach — Azure Container Apps deploy script
# Usage: .\deploy-azure.ps1
# Prerequisites: az login, docker running

$RG       = "trailcoach-rg"
$APP      = "trailcoach-app"
$REGISTRY = "trailcoachreg"
$IMAGE    = "$REGISTRY.azurecr.io/trailcoach:latest"

# --- 1. Build & push image ---
Write-Host "=== Building Docker image ===" -ForegroundColor Cyan
docker build -t $IMAGE .
if ($LASTEXITCODE -ne 0) { Write-Host "Docker build failed" -ForegroundColor Red; exit 1 }

Write-Host "=== Pushing to ACR ===" -ForegroundColor Cyan
az acr login --name $REGISTRY
if ($LASTEXITCODE -ne 0) { Write-Host "ACR login failed" -ForegroundColor Red; exit 1 }

docker push $IMAGE
if ($LASTEXITCODE -ne 0) { Write-Host "Docker push failed" -ForegroundColor Red; exit 1 }

# --- 2. Sync env vars from .env ---
Write-Host "=== Syncing env vars ===" -ForegroundColor Cyan
$skipKeys = @('RAILWAY_API_KEY', 'PORT', 'COMPOSIO_API_KEY')
$envVars = Get-Content .env |
    Where-Object { $_ -match '^\s*[A-Z_]+=.+' } |
    Where-Object { $key = ($_ -split '=', 2)[0].Trim(); $skipKeys -notcontains $key } |
    ForEach-Object {
        $parts = $_ -split '=', 2
        "$($parts[0].Trim())=$($parts[1].Trim())"
    }

az containerapp update `
    --name $APP `
    --resource-group $RG `
    --image $IMAGE `
    --set-env-vars @envVars
if ($LASTEXITCODE -ne 0) { Write-Host "containerapp update failed" -ForegroundColor Red; exit 1 }

# --- 3. Health check ---
Write-Host ""
Write-Host "=== Health check ===" -ForegroundColor Cyan
$fqdn = az containerapp show --name $APP --resource-group $RG --query "properties.configuration.ingress.fqdn" -o tsv
$url = "https://$fqdn"
Write-Host "URL: $url"
Start-Sleep -Seconds 5
curl.exe "$url/health"
