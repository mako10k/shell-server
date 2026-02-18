# Copilot Instructions

## Rollback Policy (Do Not Discard User Value)
- The agent must **not** unilaterally rollback broad changes (especially work produced through paid/premium requests and long-running tasks).
- If issues are found in translated or edited source, prioritize **minimal, local fixes** first.
- Even when failures occur, do not discard the full change set by default; preserve as much completed work as possible.

## Required Decision Process Before Rollback
- If the code is "99% correct", assume targeted fixes are preferred and continue repairing.
- Before any large-scope rollback (`multiple files` / `entire source tree`), ask the user and wait for explicit approval.
- Provide a compact comparison before asking:
  - Option A: targeted fix (recommended when feasible)
  - Option B: partial rollback (specific files only)
  - Option C: full rollback (last resort)

## Exception (Emergency Only)
- Unilateral rollback is allowed only for clear, immediate safety/compliance risks (e.g., credential leak, destructive behavior), and only to the minimum necessary scope.
- After emergency action, report exactly what was reverted and why.
