import type { ReleaseTrain } from '../store';

export const SNAPSHOT_KEY = 'yf53-release-state';
export const OUTBOX_KEY = 'yf53-release-outbox';

export type OpType = 'gate:confirm' | 'blocker:resolve' | 'train:status' | 'gates:reorder' | 'train:create';

export interface TrainOp {
  id: string;
  trainId: string;
  type: OpType;
  payload: Record<string, unknown>;
  baseRev: number;
  status: 'pending' | 'written' | 'failed' | 'conflict';
  retries: number;
  error?: string;
}

export interface Snapshot {
  activeId: string;
  operator: string;
  trains: ReleaseTrain[];
}

export function nowText(): string {
  return new Date().toLocaleTimeString();
}

export function auditId(): string {
  return `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function opId(): string {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 旧数据没有修订号，第一次打开时补上 rev=1 再照旧使用。 */
export function migrateTrain(train: ReleaseTrain): ReleaseTrain {
  if (typeof train.rev === 'number') return train;
  return {
    ...train,
    rev: 1,
    audit: [{ id: auditId(), at: nowText(), text: '旧数据迁移：已补上修订号 1，可继续正常使用' }, ...(train.audit ?? [])],
  };
}

const emptyTrain = { gates: [], blockers: [], audit: [] } as unknown as ReleaseTrain;

export function auditText(type: OpType, train: ReleaseTrain, payload: Record<string, unknown>, rev: number): string {
  const operator = (payload.operator as string) ?? '发布负责人';
  switch (type) {
    case 'gate:confirm': {
      const gate = train.gates.find((g) => g.id === payload.gateId);
      return `${operator} 确认门禁 ${gate?.repository ?? ''}（修订号 ${rev}）`;
    }
    case 'blocker:resolve': {
      const blocker = train.blockers.find((b) => b.id === payload.blockerId);
      return `${operator} 关闭阻断项 ${blocker?.title ?? ''}（修订号 ${rev}）`;
    }
    case 'train:status': {
      const label = payload.status === 'frozen' ? '已冻结' : payload.status === 'rolled-back' ? '已回滚' : '回到准备';
      return `${operator} 将状态调整为${label}（修订号 ${rev}）`;
    }
    case 'gates:reorder': {
      const moved = train.gates.find((g) => g.id === payload.activeId);
      return `${operator} 调整 ${moved?.repository ?? ''} 的发布顺序（修订号 ${rev}）`;
    }
    case 'train:create':
      return `${operator} 创建发布列车（修订号 ${rev}）`;
  }
}

export function auditTextForOp(train: ReleaseTrain, op: TrainOp, rev: number): string {
  return auditText(op.type, train, op.payload, rev);
}

/** 把操作应用到列车快照上（reducer 乐观更新与写入器落库共用，避免两份逻辑）。 */
export function applyOpToTrain(train: ReleaseTrain, op: TrainOp, rev: number): ReleaseTrain {
  let next: ReleaseTrain = train;
  switch (op.type) {
    case 'gate:confirm':
      next = { ...train, gates: train.gates.map((g) => (g.id === op.payload.gateId ? { ...g, status: 'confirmed' as const } : g)) };
      break;
    case 'blocker:resolve':
      next = { ...train, blockers: train.blockers.map((b) => (b.id === op.payload.blockerId ? { ...b, resolved: true } : b)) };
      break;
    case 'train:status':
      next = { ...train, status: op.payload.status as ReleaseTrain['status'] };
      break;
    case 'gates:reorder': {
      const gates = train.gates.map((g) => ({ ...g }));
      const from = gates.findIndex((g) => g.id === op.payload.activeId);
      const to = gates.findIndex((g) => g.id === op.payload.overId);
      if (from >= 0 && to >= 0) {
        const [moved] = gates.splice(from, 1);
        gates.splice(to, 0, moved);
      }
      next = { ...train, gates };
      break;
    }
    case 'train:create':
      next = train;
      break;
  }
  return { ...next, rev, audit: [{ id: auditId(), at: nowText(), text: auditTextForOp(next, op, rev) }, ...next.audit] };
}

export function buildTrainFromOp(op: TrainOp): ReleaseTrain {
  return {
    id: op.payload.id as string,
    name: op.payload.name as string,
    freezeAt: op.payload.freezeAt as string,
    status: 'preparing',
    rev: 1,
    gates: [],
    blockers: [],
    audit: [{ id: auditId(), at: nowText(), text: auditText('train:create', emptyTrain, op.payload, 1) }],
  };
}

export function readSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Snapshot>;
    if (!parsed || !Array.isArray(parsed.trains)) return null;
    return parsed as Snapshot;
  } catch {
    return null;
  }
}

export function writeSnapshot(snap: Snapshot): void {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
}

export function readOutbox(): TrainOp[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TrainOp[]) : [];
  } catch {
    return [];
  }
}

export function writeOutbox(ops: TrainOp[]): void {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(ops));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
