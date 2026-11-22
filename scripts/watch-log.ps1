# Live, readable view of the bridge event log (handy to show during the demo).
# Usage: .\scripts\watch-log.ps1        (Ctrl+C to stop)
$log = Join-Path $PSScriptRoot '..\data\events.log'
Write-Host "Fin x MeshMesh bridge - live events" -ForegroundColor Cyan
Get-Content $log -Wait -Tail 0 | ForEach-Object {
  try { $e = $_ | ConvertFrom-Json } catch { return }
  $t = ([datetime]$e.ts).ToLocalTime().ToString('HH:mm:ss')
  switch ($e.type) {
    'request_received'   { Write-Host "$t  Fin -> bridge   request for '$($e.body.field_label)' ($($e.body.field_type)) from $($e.body.requestor_email)" }
    'request_accepted'   { Write-Host "$t  bridge          accepted $($e.request_id) -> starting MeshMesh" -ForegroundColor Green }
    'precheck_duplicate' { Write-Host "$t  bridge          refused: $($e.field) already exists in Salesforce (nothing changed)" -ForegroundColor Yellow }
    'no_connection'      { Write-Host "$t  bridge          refused: customer has no Salesforce sandbox connected" -ForegroundColor Yellow }
    'meshmesh_status'    { if ($e.summary) { Write-Host "$t  MeshMesh        [$($e.status)] $($e.summary.Split("`n")[0])" -ForegroundColor Gray } }
    'postverify'         { Write-Host "$t  bridge          independent Salesforce check: $(if ($e.ok) {'PASSED'} else {'FAILED ' + ($e.problems -join '; ')})" -ForegroundColor $(if ($e.ok) {'Green'} else {'Red'}) }
    'notify_fin'         { Write-Host "$t  bridge -> Fin   $($e.status) (webhook $($e.results.webhook))" -ForegroundColor Cyan }
  }
}
