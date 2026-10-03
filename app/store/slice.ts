import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type GateStatus = 'pending' | 'confirmed' | 'blocked';
export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  status: GateStatus;
  version: string;
}
export type TrainStatus = 'preparing' | 'frozen' | 'rolled-back';
export interface Blocker {
  id: string;
  title: string;
  severity: 'warning' | 'critical';
  resolved: boolean;
}

export type AuditAction =
  | 'create'
  | 'gate-confirm'
  | 'blocker-resolve'
  | 'reorder'
  | 'freeze'
  | 'rollback'
  | 'resume'
  | 'note';

export interface AuditEntry {
  id: string;
  at: string;
  text: string;
  actor: string;
  action: AuditAction;
}

export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: TrainStatus;
  gates: RepositoryGate[];
  blockers: Blocker[];
  audit: AuditEntry[];
  /** 乐观锁修订号：任何一次落库修改都会 +1 */
  revision: number;
}

export interface GateMutation {
  kind: 'gate-confirm';
  gateId: string;
}
export interface BlockerMutation {
  kind: 'blocker-resolve';
  blockerId: string;
}
export interface ReorderMutation {
  kind: 'reorder';
  activeId: string;
  overId: string;
}
export interface StatusMutation {
  kind: 'status';
  status: TrainStatus;
}
export type TrainMutation = GateMutation | BlockerMutation | ReorderMutation | StatusMutation;

export type ChangeStatus = 'pending' | 'syncing' | 'error' | 'conflict';

/** 一次尚未（确认）写入远端的本地修改，按条排队 */
export interface PendingChange {
  id: string;
  trainId: string;
  kind: 'create' | 'update';
  status: ChangeStatus;
  at: string;
  detail?: string;
  /** update：本地发起时依据的远端修订号 */
  baseRevision?: number;
  mutation?: TrainMutation;
  /** 落库时要追加的审计条目（与本地已追加的是同一条） */
  audit?: AuditEntry;
  /** create：新建列车的完整快照 */
  snapshot?: ReleaseTrain;
}

export interface RemoteSeen {
  revision: number;
  updatedAt: string;
}

export interface TrainState {
  activeId: string;
  trains: ReleaseTrain[];
  pendingChanges: PendingChange[];
  /** 各列车在远端（含其他标签页写入）观察到的最新修订号 */
  remoteSeen: Record<string, RemoteSeen>;
  /** 检测到修订号冲突的列车，冻结等操作一律先挡住等刷新 */
  conflictTrainId: string | null;
}

let seq = 0;
function uid(prefix: string) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}
function nowTime() {
  return new Date().toLocaleTimeString();
}

const SYSTEM_ACTOR = '系统';

function audit(text: string, actor: string, action: AuditAction): AuditEntry {
  return { id: uid('a'), at: nowTime(), text, actor, action };
}

/** 依据变更前的列车生成审计文案与操作人记录 */
export function makeAudit(
  spec: TrainMutation | { kind: 'create' },
  train: ReleaseTrain | undefined,
  actor: string
): AuditEntry {
  switch (spec.kind) {
    case 'create':
      return audit(`${actor} 创建发布列车`, actor, 'create');
    case 'gate-confirm': {
      const gate = train?.gates.find((item) => item.id === spec.gateId);
      return audit(`${actor} 确认门禁：${gate ? gate.repository : spec.gateId}`, actor, 'gate-confirm');
    }
    case 'blocker-resolve': {
      const blocker = train?.blockers.find((item) => item.id === spec.blockerId);
      return audit(`${actor} 关闭阻断项：${blocker ? blocker.title : spec.blockerId}`, actor, 'blocker-resolve');
    }
    case 'reorder': {
      const moved = train?.gates.find((item) => item.id === spec.activeId);
      return audit(`${actor} 调整 ${moved ? moved.repository : '仓库'} 的发布顺序`, actor, 'reorder');
    }
    case 'status': {
      if (spec.status === 'frozen') return audit(`${actor} 冻结发布列车`, actor, 'freeze');
      if (spec.status === 'rolled-back') return audit(`${actor} 将发布列车回滚`, actor, 'rollback');
      return audit(`${actor} 将发布列车恢复到准备状态`, actor, 'resume');
    }
  }
}

/**
 * 把一次变更应用到列车上（纯数据操作，不含修订号递增）。
 * 本地 reducer 和远端 CAS 写入共用这一份逻辑，保证两侧结果一致。
 */
export function applyTrainMutation(train: ReleaseTrain, spec: TrainMutation, entry: AuditEntry | null) {
  switch (spec.kind) {
    case 'gate-confirm': {
      const gate = train.gates.find((item) => item.id === spec.gateId);
      if (gate) gate.status = 'confirmed';
      break;
    }
    case 'blocker-resolve': {
      const blocker = train.blockers.find((item) => item.id === spec.blockerId);
      if (blocker) blocker.resolved = true;
      break;
    }
    case 'reorder': {
      const from = train.gates.findIndex((item) => item.id === spec.activeId);
      const to = train.gates.findIndex((item) => item.id === spec.overId);
      if (from >= 0 && to >= 0) {
        const [moved] = train.gates.splice(from, 1);
        train.gates.splice(to, 0, moved);
      }
      break;
    }
    case 'status':
      train.status = spec.status;
      break;
  }
  if (entry) train.audit.unshift(entry);
}

const seedTrain: ReleaseTrain = {
  id: 'train-101',
  name: 'Sept 2026 发布列车',
  freezeAt: '2026-09-30 18:00',
  status: 'preparing',
  gates: [
    { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0' },
    { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0' },
    { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4' }
  ],
  blockers: [
    { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
    { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
  ],
  audit: [
    { id: 'a1', at: '09:20', text: `${SYSTEM_ACTOR} 创建发布列车并关联 3 个仓库`, actor: SYSTEM_ACTOR, action: 'create' }
  ],
  revision: 1
};

export const initialTrainState: TrainState = {
  activeId: seedTrain.id,
  trains: [seedTrain],
  pendingChanges: [],
  remoteSeen: { [seedTrain.id]: { revision: seedTrain.revision, updatedAt: '' } },
  conflictTrainId: null
};

export interface CommitPayload {
  trainId?: string;
  mutation: TrainMutation;
  actor: string;
}

const trainSlice = createSlice({
  name: 'train',
  initialState: initialTrainState,
  reducers: {
    hydrate(_state, action: PayloadAction<TrainState>) {
      return action.payload;
    },
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string; actor: string }>) {
      const id = uid('train');
      const entry = makeAudit({ kind: 'create' }, undefined, action.payload.actor);
      const train: ReleaseTrain = {
        id,
        name: action.payload.name,
        freezeAt: action.payload.freezeAt,
        status: 'preparing',
        gates: [],
        blockers: [],
        audit: [entry],
        revision: 1
      };
      state.trains.push(train);
      state.activeId = id;
      state.pendingChanges.push({
        id: uid('c'),
        trainId: id,
        kind: 'create',
        status: 'pending',
        at: new Date().toISOString(),
        snapshot: train,
        audit: entry
      });
    },
    activateTrain(state, action: PayloadAction<string>) {
      state.activeId = action.payload;
    },
    commitMutation(state, action: PayloadAction<CommitPayload>) {
      if (state.conflictTrainId) return;
      const train = state.trains.find((item) => item.id === (action.payload.trainId ?? state.activeId));
      if (!train) return;
      const entry = makeAudit(action.payload.mutation, train, action.payload.actor);
      const baseRevision = train.revision;
      applyTrainMutation(train, action.payload.mutation, entry);
      train.revision = baseRevision + 1;
      state.pendingChanges.push({
        id: uid('c'),
        trainId: train.id,
        kind: 'update',
        status: 'pending',
        at: new Date().toISOString(),
        baseRevision,
        mutation: action.payload.mutation,
        audit: entry
      });
    },
    changesSyncing(state, action: PayloadAction<{ ids: string[] }>) {
      for (const id of action.payload.ids) {
        const change = state.pendingChanges.find((item) => item.id === id);
        if (change && (change.status === 'pending' || change.status === 'error')) {
          change.status = 'syncing';
          change.detail = undefined;
        }
      }
    },
    changeErrored(state, action: PayloadAction<{ id: string; detail: string }>) {
      const change = state.pendingChanges.find((item) => item.id === action.payload.id);
      if (change) {
        change.status = 'error';
        change.detail = action.payload.detail;
      }
    },
    changeConflict(state, action: PayloadAction<{ id: string; trainId: string; detail: string }>) {
      const change = state.pendingChanges.find((item) => item.id === action.payload.id);
      if (change) {
        change.status = 'conflict';
        change.detail = action.payload.detail;
      }
      state.conflictTrainId = action.payload.trainId;
    },
    pruneSynced(state, action: PayloadAction<{ ids: string[] }>) {
      state.pendingChanges = state.pendingChanges.filter((item) => !action.payload.ids.includes(item.id));
    },
    remoteUpdated(state, action: PayloadAction<{ trainId: string; revision: number; updatedAt: string }>) {
      const prev = state.remoteSeen[action.payload.trainId];
      if (!prev || prev.revision < action.payload.revision) {
        state.remoteSeen[action.payload.trainId] = { revision: action.payload.revision, updatedAt: action.payload.updatedAt };
      }
    },
    /** 其他标签页的写入或本地重试确认：把对应列车替换/补齐为远端版本，本地其他在途修改原样保留 */
    remoteTrainPatched(state, action: PayloadAction<{ train: ReleaseTrain; updatedAt: string }>) {
      const idx = state.trains.findIndex((item) => item.id === action.payload.train.id);
      if (idx >= 0) state.trains[idx] = action.payload.train;
      else state.trains.push(action.payload.train);
      state.remoteSeen[action.payload.train.id] = {
        revision: action.payload.train.revision,
        updatedAt: action.payload.updatedAt
      };
    },
    writesRetry() {
      // 仅用于触发 persistenceMiddleware 重新排队，状态不变
    },
    reloadState(state, action: PayloadAction<{ trains: ReleaseTrain[]; activeId: string }>) {
      const remoteSeen: Record<string, RemoteSeen> = {};
      const now = new Date().toISOString();
      for (const train of action.payload.trains) {
        remoteSeen[train.id] = { revision: train.revision, updatedAt: now };
      }
      state.trains = action.payload.trains;
      state.activeId = action.payload.activeId;
      state.remoteSeen = remoteSeen;
      const resolvedConflictId = state.conflictTrainId;
      state.conflictTrainId = null;
      // 冲突列车的在途修改已被远端视图作废；其他列车未写入的条目（pending/error）保留继续提交/重试
      state.pendingChanges = state.pendingChanges.filter(
        (item) => !(resolvedConflictId && item.trainId === resolvedConflictId && item.status !== 'error')
      );
    }
  }
});

export interface HealthInfo {
  status: 'loading' | 'ready' | 'unhealthy' | 'error';
  checkedAt?: string;
}

/**
 * 冻结资格实时计算：门禁、阻断项、远端健康任一不满足即不可冻结。
 * 调用方在渲染中调用，任何一项变化都会立刻重算。
 */
export function computeFreezeEligibility(
  train: ReleaseTrain | undefined,
  health: HealthInfo | null
): { canFreeze: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!train) {
    reasons.push('未选择发布列车');
    return { canFreeze: false, reasons };
  }
  if (train.status === 'frozen') reasons.push('列车已处于冻结状态');
  const pendingGates = train.gates.filter((item) => item.status !== 'confirmed');
  if (pendingGates.length > 0) {
    reasons.push(`门禁未全部确认：${pendingGates.map((item) => item.repository).join('、')}`);
  }
  const openBlockers = train.blockers.filter((item) => !item.resolved);
  if (openBlockers.length > 0) {
    reasons.push(`阻断项未全部关闭：${openBlockers.map((item) => item.title).join('、')}`);
  }
  if (!health || health.status === 'loading') {
    reasons.push('远端健康检查还没回来，先挡住冻结');
  } else if (health.status === 'error') {
    reasons.push('远端健康检查查询失败');
  } else if (health.status === 'unhealthy') {
    reasons.push('远端健康检查未通过');
  }
  return { canFreeze: reasons.length === 0, reasons };
}

export const {
  activateTrain,
  changeConflict,
  changeErrored,
  changesSyncing,
  commitMutation,
  createTrain,
  hydrate,
  pruneSynced,
  reloadState,
  remoteTrainPatched,
  remoteUpdated,
  writesRetry
} = trainSlice.actions;

export { trainSlice };
