/**
 * Write-tool approval wrapper (ADR 0003).
 *
 * Every Agent write tool asks the DSH approval seam
 * (`@deepseek-ai/dsh-user-approval`, `ctx.approval.request`) **before** any
 * Zotero mutation; UI-initiated writes skip this seam by design. The wrapper
 * fails closed on every non-grant:
 *
 * - no approval service in the composition → not approved (`unavailable`),
 * - no agent on the execution (official: "an agent-less execution also
 *   degrades … without an agent there is no session to audit to and no UI to
 *   route to") → not approved,
 * - `rejected` / `cancelled` / `unavailable` → not approved; only
 *   `allowed-once` proceeds.
 *
 * A denial means the tool body never runs: no Zotero call, no retry.
 * Zotero-side denial (`write_denied` after an approved ask) is surfaced as a
 * `ZoteroError` by the session facade and must likewise terminate without
 * retrying.
 *
 * @module @hanxu131/dsh-zotero/tools/approval
 */

import type { ApprovalFace } from '../host/services.ts'

export interface ApprovalInput {
  /** The agent the call runs for (official `ToolExecution.agent`). */
  agent?: unknown
  /** The tool name shown/audited. */
  toolName: string
  /** The exact tool call being decided, when one exists. */
  callId?: unknown
  /** Human-readable why (audited with the decision). */
  reason: string
  /** Withdrawal signal (cancellation maps to a non-grant). */
  signal?: AbortSignal
}

export type ApprovalResult = { approved: true; outcome: 'allowed-once' } | { approved: false; outcome: 'unavailable' | 'rejected' | 'cancelled' }

/**
 * Ask for one write approval; fails closed when the seam, the agent, or the
 * answerer chain cannot grant.
 */
export async function requestWriteApproval(approval: ApprovalFace | undefined, input: ApprovalInput): Promise<ApprovalResult> {
  if (approval === undefined) return { approved: false, outcome: 'unavailable' }
  if (input.agent === undefined || input.agent === null) return { approved: false, outcome: 'unavailable' }
  let outcome: Awaited<ReturnType<ApprovalFace['request']>>
  try {
    outcome = await approval.request({
      agent: input.agent,
      toolName: input.toolName,
      reason: input.reason,
      ...(input.callId !== undefined ? { callId: input.callId } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })
  } catch {
    // A throwing approval seam is fail-closed, same as the official degrade.
    return { approved: false, outcome: 'unavailable' }
  }
  if (outcome === 'allowed-once') return { approved: true, outcome }
  return { approved: false, outcome }
}
