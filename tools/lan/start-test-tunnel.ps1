# Serve this laptop's REEP at https://test.sast-skills.com through a Cloudflare
# Tunnel. Changes nothing in AWS: the hostname is a record in the Cloudflare
# zone, and the tunnel connects outbound from this machine.
#
#   .\tools\lan\start-test-tunnel.ps1          # set up (first time) and run
#   .\tools\lan\start-test-tunnel.ps1 -Remove  # delete the tunnel afterwards
#
# Start the API (port 3300) and `npx ng serve` (port 4200) first, with
# ENV=dev and WEB_ORIGIN=https://test.sast-skills.com in apps/api-py/.env.
# Steps and reasoning: docs/lan-hosting-test.md.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$Name = 'reep-test'
$Hostname = 'test.sast-skills.com'
$Dir = Join-Path $env:USERPROFILE '.cloudflared'
$Config = Join-Path $Dir 'reep-test.yml'

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Host 'Installing cloudflared...'
    winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

if ($Remove) {
    cloudflared tunnel cleanup $Name
    cloudflared tunnel delete $Name
    Remove-Item $Config -ErrorAction SilentlyContinue
    Write-Host "Tunnel deleted. Remove the 'test' CNAME in the Cloudflare dashboard (DNS for sast-skills.com)."
    exit 0
}

if (-not (Test-Path (Join-Path $Dir 'cert.pem'))) {
    Write-Host 'A browser will open: sign in to Cloudflare and pick sast-skills.com.'
    cloudflared tunnel login
}

$tunnels = cloudflared tunnel list --output json | ConvertFrom-Json
$tunnel = $tunnels | Where-Object { $_.name -eq $Name } | Select-Object -First 1
if (-not $tunnel) {
    cloudflared tunnel create $Name | Out-Host
    $tunnel = cloudflared tunnel list --output json | ConvertFrom-Json |
              Where-Object { $_.name -eq $Name } | Select-Object -First 1
}
$Credentials = Join-Path $Dir ("{0}.json" -f $tunnel.id)

# Creates (or confirms) the CNAME test -> <id>.cfargotunnel.com. Fails, rather
# than overwriting, if some other record already holds the name.
cloudflared tunnel route dns $Name $Hostname

@"
tunnel: $($tunnel.id)
credentials-file: $Credentials
ingress:
  - hostname: $Hostname
    service: http://localhost:4200
    originRequest:
      httpHostHeader: localhost:4200
  - service: http_status:404
"@ | Set-Content -Encoding ascii $Config

foreach ($port in 3300, 4200) {
    if (-not (Test-NetConnection 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue)) {
        Write-Warning "Nothing is listening on port $port yet; start it or the site will show a 502."
    }
}

Write-Host "Serving https://$Hostname  (Ctrl+C to stop)"
cloudflared tunnel --config $Config run $Name
