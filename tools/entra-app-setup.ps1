#Requires -Version 7
<#
.SYNOPSIS
    Register the Microsoft Entra app that Power Assistant signs in against.

.DESCRIPTION
    Power Assistant reaches Microsoft 365 through an app registration of your own,
    so no third party sits in the middle and your password never touches the
    plugin. This does what the README's manual portal steps do, in one run:

      * registers a single-tenant app
      * turns on public client flows, which the device-code sign-in needs
      * asks for the delegated permissions the plugin actually uses:
            offline_access, openid, profile   sign in, and stay signed in
            Calendars.Read                    Import meeting from calendar
            Mail.Send                         Email this page
      * prints the two ids to paste into the plugin's settings

    It creates nothing else. It grants no admin consent and stores no secret:
    you approve the permissions yourself, in your own browser, the first time you
    press Connect. Rerunning it is safe. If a registration with this name already
    exists it is repaired in place rather than duplicated, which is also how you
    add a permission to an app made before that feature existed.

.PARAMETER Name
    Display name for the registration. Default "Power Assistant".

.PARAMETER DryRun
    Show what would happen and change nothing.

.PARAMETER Force
    Register a new app even when one with this name already exists.

.EXAMPLE
    ./entra-app-setup.ps1
    Create or repair the registration, then print the ids.

.EXAMPLE
    ./entra-app-setup.ps1 -DryRun
    See what it would do first.

.NOTES
    Needs the Azure CLI: https://aka.ms/installazurecli
    Your tenant must let you register apps. Most do; some workplaces do not, and
    the script says so plainly rather than failing halfway.
#>
[CmdletBinding()]
param(
    [string]$Name = "Power Assistant",
    [switch]$DryRun,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# Microsoft Graph's own app id. Constant across every tenant.
$GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000"

# What the plugin asks for at sign-in. Keep this list in step with SCOPE in
# graph.ts: the app registration says what MAY be consented, the plugin's scope
# string says what IS asked for, and a permission missing here shows up as a
# consent failure at Connect rather than anything more helpful.
$WANTED = @(
    @{ Name = "offline_access"; Why = "stay signed in without asking again" }
    @{ Name = "openid"; Why = "sign in" }
    @{ Name = "profile"; Why = "read your name" }
    @{ Name = "Calendars.Read"; Why = "Import meeting from calendar" }
    @{ Name = "Mail.Send"; Why = "Email this page" }
)

function Say($msg) { Write-Host $msg }
function Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host $msg -ForegroundColor Yellow }
function Die($msg) { Write-Host "`n$msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- prerequisites

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Die "The Azure CLI is not installed. Get it from https://aka.ms/installazurecli (or: winget install Microsoft.AzureCLI), then run this again."
}

Step "Checking who you are signed in as..."
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Say "Not signed in. Opening a browser..."
    if ($DryRun) {
        Say "  [dry run] would run: az login --allow-no-subscriptions"
        Die "Sign in first, then rerun with -DryRun to see the rest."
    }
    # --allow-no-subscriptions: an app registration lives in Entra, not in a
    # subscription, so an account with no Azure subscription can still do this.
    az login --allow-no-subscriptions --only-show-errors | Out-Null
    $account = az account show 2>$null | ConvertFrom-Json
    if (-not $account) { Die "Sign-in did not complete. Nothing was changed." }
}
$tenantId = $account.tenantId
Say "  signed in as : $($account.user.name)"
Say "  tenant       : $tenantId"

Step "Checking that your organization lets you register an app..."
$policy = az rest --method GET --url "https://graph.microsoft.com/v1.0/policies/authorizationPolicy" 2>$null | ConvertFrom-Json
if ($null -eq $policy) {
    Say "  cannot read the tenant policy from this account, which is common and is not a problem."
    Say "  carrying on; if registration is blocked, the create step below will say so."
}
elseif (-not $policy.defaultUserRolePermissions.allowedToCreateApps) {
    Die @"
Your organization does not allow users to register apps, so this cannot be done from here.
Ask whoever administers Microsoft 365 to register an app for you with:
  * Allow public client flows: Yes
  * Delegated Microsoft Graph permissions: Calendars.Read, Mail.Send (plus offline_access, openid, profile)
then paste its Application (client) ID and your Directory (tenant) ID into the plugin's settings.
"@
}
else {
    Say "  yes."
}

# ------------------------------------------------------------------ permissions

# Resolved from the live Graph service principal rather than hardcoded. The ids
# are stable, but looking them up means a typo here can never quietly request the
# wrong permission, and a renamed one fails loudly instead.
Step "Looking up the permission ids in your tenant..."
$scopes = az ad sp show --id $GRAPH_APP_ID --query "oauth2PermissionScopes[].{value:value,id:id,type:type}" -o json 2>$null | ConvertFrom-Json
if (-not $scopes) { Die "Could not read the Microsoft Graph service principal. Are you signed in to the right tenant?" }

$resourceAccess = @()
$needsAdmin = @()
foreach ($w in $WANTED) {
    $found = $scopes | Where-Object { $_.value -eq $w.Name } | Select-Object -First 1
    if (-not $found) { Die "Microsoft Graph in this tenant has no '$($w.Name)' permission. Nothing was changed." }
    Say ("  {0,-16} {1}  ({2})" -f $found.value, $found.id, $w.Why)
    if ($found.type -ne "User") { $needsAdmin += $w.Name }
    $resourceAccess += @{ id = $found.id; type = "Scope" }
}
if ($needsAdmin.Count) {
    Warn "  note: $($needsAdmin -join ', ') needs an administrator's approval in this tenant. Everything else still works; that feature will not until they approve."
}
else {
    Say "  all of these are yours to approve, so no administrator is needed."
}

# ------------------------------------------------------------------ the app

Step "Looking for an existing '$Name' registration..."
$existing = az ad app list --display-name $Name --query "[].{appId:appId,id:id,displayName:displayName}" -o json 2>$null | ConvertFrom-Json
$app = $null
if ($existing -and $existing.Count -gt 0 -and -not $Force) {
    $app = $existing[0]
    Say "  found one: $($app.appId)"
    Say "  repairing it in place rather than making a second. Pass -Force for a new one."
}
elseif ($existing -and $existing.Count -gt 0 -and $Force) {
    Say "  found one, but -Force was given, so a second will be registered."
}
else {
    Say "  none, so a new one will be registered."
}

$rraFile = Join-Path ([System.IO.Path]::GetTempPath()) "power-assistant-entra-permissions.json"
@(@{ resourceAppId = $GRAPH_APP_ID; resourceAccess = $resourceAccess }) | ConvertTo-Json -Depth 6 -AsArray | Set-Content -LiteralPath $rraFile -Encoding utf8

try {
    if ($DryRun) {
        Step "[dry run] nothing below actually runs."
        if ($app) {
            Say "  would update app $($app.appId):"
            Say "    az ad app update --id $($app.appId) --is-fallback-public-client true --required-resource-accesses `"@$rraFile`""
        }
        else {
            Say "  would create the app:"
            Say "    az ad app create --display-name `"$Name`" --sign-in-audience AzureADMyOrg --is-fallback-public-client true --required-resource-accesses `"@$rraFile`""
        }
        Say "  would then make sure the app has a service principal, and print the two ids."
        Say "`nPermissions file that would be sent:"
        Get-Content -LiteralPath $rraFile | ForEach-Object { Say "  $_" }
        Say "`nNothing was changed."
        return
    }

    if ($app) {
        Step "Updating the registration..."
        # public client flows: what the device-code sign-in needs, and the one
        # setting people miss doing this by hand
        az ad app update --id $app.appId --is-fallback-public-client true --required-resource-accesses "@$rraFile" --only-show-errors | Out-Null
        $appId = $app.appId
    }
    else {
        Step "Registering the app..."
        # AzureADMyOrg: your organization only, which is why the plugin needs the
        # tenant id and cannot use "common"
        $created = az ad app create `
            --display-name $Name `
            --sign-in-audience AzureADMyOrg `
            --is-fallback-public-client true `
            --required-resource-accesses "@$rraFile" `
            --only-show-errors 2>$null | ConvertFrom-Json
        if (-not $created) { Die "Could not register the app. Nothing was changed." }
        $appId = $created.appId
    }
    Say "  application (client) id: $appId"

    # The service principal is what the consent is recorded against. Entra makes
    # one on first consent anyway, so this only means the app shows up under
    # Enterprise applications straight away, and an admin can approve it there if
    # your tenant ever needs that. Not worth failing over.
    Step "Making sure it has a service principal..."
    $sp = az ad sp show --id $appId 2>$null | ConvertFrom-Json
    if ($sp) {
        Say "  already there."
    }
    else {
        az ad sp create --id $appId --only-show-errors 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { Say "  created." } else { Warn "  could not create one, which is fine: Entra will make it when you first approve the sign-in." }
    }
}
finally {
    Remove-Item -LiteralPath $rraFile -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------------ hand off

Write-Host "`n────────────────────────────────────────────────────────────" -ForegroundColor Green
Write-Host " Paste these into Power Assistant settings, Microsoft 365:" -ForegroundColor Green
Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor Green
Write-Host " Application (client) ID : $appId"
Write-Host " Tenant                  : $tenantId"
Write-Host "────────────────────────────────────────────────────────────" -ForegroundColor Green
Write-Host @"

Then press Connect, open the page it shows, type the code, and approve.
The approval screen will name the calendar and the send-mail permission;
that is the plugin asking for exactly what the two features need.
"@
