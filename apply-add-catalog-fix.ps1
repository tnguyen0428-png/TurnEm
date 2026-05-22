$ErrorActionPreference = 'Stop'
$path = 'src\components\register\TicketModal.tsx'
$lines = [System.Collections.Generic.List[string]]::new()
foreach ($l in (Get-Content -Path $path)) { [void]$lines.Add($l) }

function Find-Index([System.Collections.Generic.List[string]]$arr, [string]$needle, [int]$startAt = 0) {
  for ($i = $startAt; $i -lt $arr.Count; $i++) {
    if ($arr[$i] -eq $needle) { return $i }
  }
  return -1
}

$fnAnchor = '  function addCatalogService(svcId: string) {'
$fnIdx = Find-Index $lines $fnAnchor
if ($fnIdx -lt 0) { Write-Error "addCatalogService function not found." }

[string[]]$oldStaff = @(
  '    const m = manicuristById(primaryManicuristId);',
  '    const newLine: DraftLine = {',
  '      serviceId: svc.id,',
  '      name: svc.name,',
  '      staff1Id: m?.id ?? null,',
  '      staff1Name: m?.name ?? '''',',
  '      staff1Color: m?.color ?? ''#9ca3af'','
)
[string[]]$newStaff = @(
  '    // Do NOT default the staff to the ticket''s primary. The cashier must',
  '    // explicitly pick a staff via the dropdown so ensureManicuristBusyForAddedLine',
  '    // only runs for the intended manicurist. Previously, defaulting to the',
  '    // primary staff appended the new service to that primary''s queue entry',
  '    // immediately, which caused a phantom ticket_item to be inserted by',
  '    // updateOpenTicket when the cashier later changed the dropdown to a',
  '    // different staff (the modal''s `lines` state held a stale draft).',
  '    const newLine: DraftLine = {',
  '      serviceId: svc.id,',
  '      name: svc.name,',
  '      staff1Id: null,',
  '      staff1Name: '''',',
  '      staff1Color: ''#9ca3af'','
)

$startIdx = -1
for ($i = $fnIdx; $i -lt $lines.Count -and $i -lt $fnIdx + 30; $i++) {
  $ok = $true
  for ($j = 0; $j -lt $oldStaff.Length; $j++) {
    if ($i + $j -ge $lines.Count -or $lines[$i + $j] -ne $oldStaff[$j]) { $ok = $false; break }
  }
  if ($ok) { $startIdx = $i; break }
}
if ($startIdx -lt 0) { Write-Error "Default-staff block not found inside addCatalogService." }

for ($k = 0; $k -lt $oldStaff.Length; $k++) { $lines.RemoveAt($startIdx) }
$lines.InsertRange($startIdx, [System.Collections.Generic.IEnumerable[string]]$newStaff)

$callAnchor = '    ensureManicuristBusyForAddedLine(newLine);'
$callIdx = Find-Index $lines $callAnchor $startIdx
if ($callIdx -ge 0 -and $callIdx -lt $startIdx + 30) {
  $lines[$callIdx] = '    // No ensureManicuristBusyForAddedLine here — staff is null at this point.'
}

$content = $lines -join "`r`n"
Set-Content -Path $path -Value $content -NoNewline -Encoding utf8

Write-Host "Done. addCatalogService now defaults staff to null."
Write-Host "Edit was at line $($startIdx+1)."
Write-Host "Run 'git diff src/components/register/TicketModal.tsx' to review."
