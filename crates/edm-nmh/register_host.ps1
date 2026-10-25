# Registers EDM Native Messaging Host for Microsoft Edge, Google Chrome, and Brave
$manifestPath = (Resolve-Path "$PSScriptRoot\com.edm.nmh.json").Path

$registryPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.edm.nmh",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.edm.nmh",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.edm.nmh"
)

foreach ($regPath in $registryPaths) {
    $parent = Split-Path $regPath -Parent
    if (!(Test-Path $parent)) {
        New-Item -Path $parent -Force | Out-Null
    }
    New-Item -Path $regPath -Force -Value $manifestPath | Out-Null
    Write-Host "[OK] Registered EDM Native Host at $regPath -> $manifestPath"
}
