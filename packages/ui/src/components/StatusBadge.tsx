import type { RunStatus } from '@agentops/contracts';

const STATUS_COLORS: Record<RunStatus, string> = {
  RUNNING: '#2563eb',
  COMPLETED: '#16a34a',
  FAILED: '#dc2626',
  CANCELLED: '#d97706',
  TERMINATED: '#dc2626',
  TIMED_OUT: '#dc2626',
  CONTINUED_AS_NEW: '#2563eb',
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className="status-badge" style={{ backgroundColor: STATUS_COLORS[status] }}>
      {status}
    </span>
  );
}
