$ErrorActionPreference = 'Stop'
$path = 'src\lib\tickets.ts'
$lines = [System.Collections.Generic.List[string]]::new()
foreach ($l in (Get-Content -Path $path)) { [void]$lines.Add($l) }

function Find-Index([System.Collections.Generic.List[string]]$arr, [string]$needle, [int]$startAt = 0) {
  for ($i = $startAt; $i -lt $arr.Count; $i++) {
    if ($arr[$i] -eq $needle) { return $i }
  }
  return -1
}

# ─── Edit 1: appendItemsToTicket guard ───
# Find the `if (items.length === 0) return fetchTicket(ticketId);` that sits
# 2 lines after `): Promise<Ticket | null> {`. Several functions return
# Promise<Ticket | null> in the file, so we anchor on the items-length line.
$anchor1 = '  if (items.length === 0) return fetchTicket(ticketId);'
$i1 = Find-Index $lines $anchor1
if ($i1 -lt 0) { Write-Error "Edit 1 anchor not found." }

$replacement1 = @(
  '  // Skip cashier-created add-children. TicketModal.updateOpenTicket owns',
  '  // their ticket_items lifecycle. Without this filter, the AppContext',
  '  // syncQueue (justAssigned + sibling-reconcile) paths race with the',
  "  // cashier's save and insert a duplicate line for the same (visit,",
  '  // staff, service). Parallels the DB trigger fix in migration',
  '  // 20260522050000_ticket_trigger_skip_add_children.',
  '  const filteredAddChildren = items.filter(',
  "    (it) => !it.queueEntryId || !it.queueEntryId.includes('-add-'),",
  '  );',
  '  if (filteredAddChildren.length === 0) return fetchTicket(ticketId);',
  '  items = filteredAddChildren;'
)

$lines.RemoveAt($i1)
$lines.InsertRange($i1, $replacement1)

# ─── Edit 2: syncEntryToTicket guard ───
# Find `if (!entry.assignedManicuristId) return false;` — this is the first
# line of syncEntryToTicket's body. Locate the FIRST occurrence; there is
# only one in the file.
$anchor2 = '  if (!entry.assignedManicuristId) return false;'
$i2 = Find-Index $lines $anchor2
if ($i2 -lt 0) { Write-Error "Edit 2 anchor not found." }

$insertion2 = @(
  '  // Skip cashier-created add-children. TicketModal owns their lifecycle.',
  '  // Without this guard, the broad syncEntryToTicket pass in',
  '  // AppContext.syncQueue recreates ticket_items that the cashier removed',
  '  // via the modal. Parallels the DB trigger fix in migration',
  '  // 20260522050000_ticket_trigger_skip_add_children.',
  "  if (entry.id.includes('-add-')) return false;",
  ''
)
$lines.InsertRange($i2, $insertion2)

# Write back preserving original line ending if possible. Use Set-Content
# with -Encoding utf8 (UTF-8 without BOM in PS5; OK for source code).
$content = $lines -join "`r`n"
Set-Content -Path $path -Value $content -NoNewline -Encoding utf8

Write-Host "Done. Edit 1 at line $($i1+1), Edit 2 at line $($i2+1)."
Write-Host "Run 'git diff src/lib/tickets.ts' to review."
