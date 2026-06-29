import type { ToolApprovalConfiguration } from 'ai';
import type { AIPermissionMode } from '../types';
import { requestApproval as defaultRequestApproval } from '../shared/approvalGate';
import { resolveCapabilityId } from './permissionGrants';
import { checkCommandSafety } from '../cattyAgent/safety';
import { getActivePermissionGrants, PermissionGrantStore } from './permissionGrants';
import type { CommandReviewSession } from '../review/commandReviewer';
import { recordReviewResult } from '../review/commandReviewer';
import cattyToolSpecs from './generated/cattyToolSpecs.json';

type CattyToolPolicySpec = {
  toolName: string;
  capabilityId: string;
  policy: {
    write: boolean;
    bypassesApproval: boolean;
    bypassesObserverBlock?: boolean;
  };
};

const policyByToolName = new Map<string, CattyToolPolicySpec>(
  (cattyToolSpecs as CattyToolPolicySpec[]).map((spec) => [spec.toolName, spec]),
);

function needsUserApproval(
  toolName: string,
  permissionMode: AIPermissionMode,
): boolean {
  if (permissionMode !== 'confirm') return false;
  const spec = policyByToolName.get(toolName);
  if (!spec) return false;
  return spec.policy.write && !spec.policy.bypassesApproval;
}

/** Extract the shell command from a tool call's arguments, if applicable. */
function extractCommand(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (toolName === 'terminal_execute') {
    const cmd = input?.command;
    return typeof cmd === 'string' && cmd.trim() ? cmd.trim() : null;
  }
  return null;
}

export function buildCattyToolApproval(input: {
  permissionMode: AIPermissionMode;
  chatSessionId?: string;
  commandBlocklist?: string[];
  reviewSession?: CommandReviewSession;
  requestApproval?: typeof defaultRequestApproval;
}): ToolApprovalConfiguration<Record<string, never>, import('./cattyRuntimeContext').CattyRuntimeContext> {
  const {
    permissionMode,
    chatSessionId,
    commandBlocklist,
    reviewSession,
    requestApproval = defaultRequestApproval,
  } = input;

  return async ({ toolCall }) => {
    const spec = policyByToolName.get(toolCall.toolName);
    if (!spec?.policy.write) {
      return undefined;
    }

    // ── observer mode (existing) ──────────────────────────────────────
    if (permissionMode === 'observer' && !spec.policy.bypassesObserverBlock) {
      return { type: 'denied' as const, reason: 'Observer mode blocks write operations.' };
    }

    // ── auto / confirm without approval (existing) ────────────────────
    if (permissionMode !== 'review' && !needsUserApproval(toolCall.toolName, permissionMode)) {
      return undefined;
    }

    const args = (toolCall.input ?? {}) as Record<string, unknown>;
    let reviewNote: string | undefined;

    // ── review mode — three-layer defence ─────────────────────────────
    if (permissionMode === 'review') {
      const command = extractCommand(toolCall.toolName, args);

      // Layer 1: Blacklist — always deny dangerous commands
      if (command && commandBlocklist?.length) {
        const safety = checkCommandSafety(command, commandBlocklist);
        if (safety.blocked) {
          recordReviewResult(toolCall.toolCallId, {
            risk: 'dangerous',
            reason: `匹配规则: ${safety.matchedPattern}`,
            source: 'blacklist',
          });
          return {
            type: 'denied' as const,
            reason: `命令被黑名单拦截。匹配规则: ${safety.matchedPattern}`,
          };
        }
      }

      // Layer 2: Whitelist — always approve user-granted command patterns
      if (command) {
        const grants = getActivePermissionGrants();
        if (grants.length > 0) {
          const store = new PermissionGrantStore([...grants]);
          const match = store.match({
            capabilityId: spec.capabilityId ?? resolveCapabilityId(toolCall.toolName),
            chatSessionId,
            args: { command },
          });
          if (match) {
            recordReviewResult(toolCall.toolCallId, {
              risk: 'safe',
              reason: match.note || '用户已授权此命令模式',
              source: 'whitelist',
            });
            return undefined; // Whitelisted — auto-approve
          }
        }
      }

      // Layer 3: AI review — classify risk and decide
      if (command && reviewSession) {
        const result = await reviewSession.review(command);
        // Tag the result so the UI badge shows the correct source label.
        result.source = 'ai-review';

        switch (result.risk) {
          case 'safe':
            recordReviewResult(toolCall.toolCallId, result);
            return undefined;

          case 'dangerous':
            // Auto-deny with actionable feedback so the main AI can
            // adjust its approach — the SDK feeds this reason back to
            // the model as a tool-result error in the next step.
            return {
              type: 'denied' as const,
              reason: `[安全审查拒绝] ${result.reason}。请改用更安全的替代方案，避免破坏性或不可逆的操作。`,
            };

          case 'caution':
            // Record review result so it shows in the tool output if user approves.
            recordReviewResult(toolCall.toolCallId, result);
            // Fall through to the approval dialog with the review note.
            reviewNote = result.reason;
            break;
        }
      }

      // No command to review → fall through to confirm.
    }

    // ── confirm mode / review-caution fallback ─────────────────────────
    const approved = await requestApproval(
      toolCall.toolCallId,
      toolCall.toolName,
      args,
      chatSessionId,
      undefined,
      spec.capabilityId ?? resolveCapabilityId(toolCall.toolName),
      reviewNote,
    );

    if (approved) {
      return { type: 'approved' as const };
    }
    return { type: 'denied' as const, reason: 'User denied tool execution.' };
  };
}
