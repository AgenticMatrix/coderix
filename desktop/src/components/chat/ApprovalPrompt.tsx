import { useChatStore } from '../../stores/chatStore';

interface ApprovalPromptProps {
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
}

export function ApprovalPrompt({ onApprove, onDeny }: ApprovalPromptProps) {
  const pendingApproval = useChatStore((s) => s.pendingApproval);

  if (!pendingApproval) return null;

  return (
    <div className="approval-overlay">
      <div className="approval-dialog">
        <div className="approval-header">
          <span className="approval-icon">⚠</span>
          <span className="approval-title">Permission Required</span>
        </div>
        <div className="approval-body">
          <div className="approval-tool-name">{pendingApproval.toolName}</div>
          <div className="approval-description">
            {pendingApproval.description || pendingApproval.command}
          </div>
        </div>
        <div className="approval-actions">
          <button
            className="btn btn-approve"
            onClick={() => onApprove(pendingApproval.requestId)}
          >
            ✓ Allow Once
          </button>
          <button
            className="btn btn-deny"
            onClick={() => onDeny(pendingApproval.requestId)}
          >
            ✕ Deny
          </button>
        </div>
      </div>
    </div>
  );
}
