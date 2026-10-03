import { configureStore, createAsyncThunk, createSlice, type Middleware, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import {
  OUTBOX_KEY,
  SNAPSHOT_KEY,
  applyOpToTrain,
  auditText,
  buildTrainFromOp,
  delay,
  migrateTrain,
  opId,
  readOutbox,
  readSnapshot,
  writeOutbox,
  writeSnapshot,
  type OpType,
  type Snapshot,
  type TrainOp,
} from '../lib/persistence';

export type GateStatus = 'pending' | 'confirmed' | 'blocked';
export interface RepositoryGate {
  id: string;
  repository: string;
  owner: string;
  dependency: string;
  status: GateStatus;
  version: string;
}
export interface ReleaseTrain {
  id: string;
  name: string;
  freezeAt: string;
  status: 'preparing' | 'frozen' | 'rolled-back';
  /** 修订号：每次落库成功 +1，用于乐观并发控制，防止两个标签页互相覆盖。 */
  rev: number;
  gates: RepositoryGate[];
  blockers: Array<{ id: string; title: string; severity: 'warning' | 'critical'; resolved: boolean }>;
  audit: Array<{ id: string; at: string; text: string }>;
}

interface StaleNotice {
  trainId: string;
  storedRev: number;
}

interface TrainState {
  activeId: string;
  operator: string;
  trains: ReleaseTrain[];
  /** 待落库 / 失败待重试的写操作队列；每个操作独立重试，失败只重试没写进去的部分。 */
  outbox: TrainOp[];
  /** 其他标签页已写入更高修订号时的刷新提示。 */
  stale: StaleNotice | null;
}

const initial: TrainState = {
  activeId: 'train-101',
  operator: '发布负责人',
  outbox: [],
  stale: null,
  trains: [{
    id: 'train-101',
    name: 'Sept 2026 发布列车',
    freezeAt: '2026-09-30 18:00',
    status: 'preparing',
    rev: 1,
    gates: [
      { id: 'g1', repository: 'web-console', owner: '陈珂', dependency: 'shared-ui@4.2', status: 'confirmed', version: '4.8.0' },
      { id: 'g2', repository: 'gateway', owner: '周扬', dependency: 'auth-sdk@2.1', status: 'pending', version: '2.12.0' },
      { id: 'g3', repository: 'data-sync', owner: '罗雨', dependency: 'gateway@2.12', status: 'blocked', version: '1.9.4' }
    ],
    blockers: [
      { id: 'b1', title: 'data-sync 依赖的网关版本尚未确认', severity: 'critical', resolved: false },
      { id: 'b2', title: '移动端发布说明缺少回滚章节', severity: 'warning', resolved: false }
    ],
    audit: [{ id: 'a1', at: '09:20', text: '创建发布列车并关联 3 个仓库' }]
  }]
};

function nowText(): string {
  return new Date().toLocaleTimeString();
}
function auditId(): string {
  return `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const trainSlice = createSlice({
  name: 'train',
  initialState: initial,
  reducers: {
    createTrain(state, action: PayloadAction<{ name: string; freezeAt: string }>) {
      const id = `train-${Date.now()}`;
      state.trains.push({
        id,
        ...action.payload,
        status: 'preparing',
        rev: 1,
        gates: [],
        blockers: [],
        audit: [{ id: auditId(), at: nowText(), text: auditText('train:create', { gates: [], blockers: [], audit: [] } as unknown as ReleaseTrain, { ...action.payload, operator: state.operator }, 1) }]
      });
      state.activeId = id;
    },
    activateTrain(state, action: PayloadAction<string>) { state.activeId = action.payload; },
    setOperator(state, action: PayloadAction<string>) { state.operator = action.payload; },
    confirmGate(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const gate = train?.gates.find((item) => item.id === action.payload);
      if (!train || !gate || gate.status === 'confirmed') return;
      gate.status = 'confirmed';
      train.rev += 1;
      train.audit.unshift({ id: auditId(), at: nowText(), text: auditText('gate:confirm', train, { gateId: gate.id, operator: state.operator }, train.rev) });
    },
    setFreeze(state, action: PayloadAction<ReleaseTrain['status']>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      train.status = action.payload;
      train.rev += 1;
      train.audit.unshift({ id: auditId(), at: nowText(), text: auditText('train:status', train, { status: action.payload, operator: state.operator }, train.rev) });
    },
    resolveBlocker(state, action: PayloadAction<string>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      const blocker = train?.blockers.find((item) => item.id === action.payload);
      if (!train || !blocker || blocker.resolved) return;
      blocker.resolved = true;
      train.rev += 1;
      train.audit.unshift({ id: auditId(), at: nowText(), text: auditText('blocker:resolve', train, { blockerId: blocker.id, operator: state.operator }, train.rev) });
    },
    reorderGates(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const train = state.trains.find((item) => item.id === state.activeId);
      if (!train) return;
      const from = train.gates.findIndex((item) => item.id === action.payload.activeId);
      const to = train.gates.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = train.gates.splice(from, 1);
      train.gates.splice(to, 0, moved);
      train.rev += 1;
      train.audit.unshift({ id: auditId(), at: nowText(), text: auditText('gates:reorder', train, { ...action.payload, operator: state.operator }, train.rev) });
    },
    enqueueOp(state, action: PayloadAction<TrainOp>) { state.outbox.push(action.payload); },
    opSucceeded(state, action: PayloadAction<{ opId: string }>) {
      const op = state.outbox.find((item) => item.id === action.payload.opId);
      if (op) op.status = 'written';
    },
    opFailed(state, action: PayloadAction<{ opId: string; error: string }>) {
      const op = state.outbox.find((item) => item.id === action.payload.opId);
      if (op) {
        op.status = 'failed';
        op.retries += 1;
        op.error = action.payload.error;
      }
    },
    opConflict(state, action: PayloadAction<{ opId: string; storedRev: number }>) {
      const op = state.outbox.find((item) => item.id === action.payload.opId);
      if (op) op.status = 'conflict';
      const train = state.trains.find((item) => item.id === op?.trainId);
      if (train) state.stale = { trainId: train.id, storedRev: action.payload.storedRev };
    },
    setStale(state, action: PayloadAction<StaleNotice>) { state.stale = action.payload; },
    clearStale(state) { state.stale = null; },
    pruneOutbox(state) { state.outbox = state.outbox.filter((item) => item.status === 'written'); },
    setOutbox(state, action: PayloadAction<TrainOp[]>) { state.outbox = action.payload; },
    replaceState(_state, action: PayloadAction<TrainState>) { return action.payload; }
  }
});

export const {
  activateTrain,
  clearStale,
  confirmGate,
  createTrain,
  enqueueOp,
  opConflict,
  opFailed,
  opSucceeded,
  pruneOutbox,
  reorderGates,
  replaceState,
  resolveBlocker,
  setFreeze,
  setOperator,
  setStale
} = trainSlice.actions;

/** 把 reducer 的乐观变更翻译成携带基准 rev 的写操作。 */
function buildOp(type: string, action: PayloadAction<unknown>, prev: TrainState, next: TrainState): TrainOp | null {
  const operator = prev.operator;
  if (type === 'train/createTrain') {
    const payload = action.payload as { name: string; freezeAt: string };
    const created = next.trains.find((item) => item.name === payload.name && item.freezeAt === payload.freezeAt);
    if (!created) return null;
    return {
      id: opId(),
      trainId: created.id,
      type: 'train:create',
      payload: { id: created.id, name: payload.name, freezeAt: payload.freezeAt, operator },
      baseRev: 0,
      status: 'pending',
      retries: 0
    };
  }
  const train = prev.trains.find((item) => item.id === prev.activeId);
  if (!train) return null;
  const base = { id: opId(), trainId: train.id, baseRev: train.rev, status: 'pending' as const, retries: 0, payload: { operator } };
  switch (type) {
    case 'train/confirmGate':
      return { ...base, type: 'gate:confirm', payload: { ...base.payload, gateId: action.payload } };
    case 'train/resolveBlocker':
      return { ...base, type: 'blocker:resolve', payload: { ...base.payload, blockerId: action.payload } };
    case 'train/setFreeze':
      return { ...base, type: 'train:status', payload: { ...base.payload, status: action.payload } };
    case 'train/reorderGates':
      return { ...base, type: 'gates:reorder', payload: { ...base.payload, ...(action.payload as object) } };
    default:
      return null;
  }
}

const MUTATION_TYPES: Record<string, OpType> = {
  'train/createTrain': 'train:create',
  'train/confirmGate': 'gate:confirm',
  'train/resolveBlocker': 'blocker:resolve',
  'train/setFreeze': 'train:status',
  'train/reorderGates': 'gates:reorder'
};

/** 持久化中间件：变更入队 → 触发写入器。stale 时不再入队，避免堆积必然冲突的写。 */
const persistenceMiddleware: Middleware = (storeApi) => (next) => (action) => {
  const prev = storeApi.getState() as TrainState;
  const result = next(action);
  if (typeof action === 'object' && action !== null && 'type' in action) {
    const type = (action as { type: unknown }).type;
    if (typeof type === 'string' && MUTATION_TYPES[type] && !prev.stale) {
      const nextState = storeApi.getState() as TrainState;
      const op = buildOp(type, action as PayloadAction<unknown>, prev, nextState);
      if (op) {
        storeApi.dispatch(enqueueOp(op));
        writeOutbox(storeApi.getState().train.outbox);
        void (storeApi.dispatch as AppDispatch)(flushOutbox());
      }
    }
  }
  return result;
};

let flushing = false;

/** 写入器：逐个操作落库，失败只重试该操作；基准 rev 与远端不一致则判冲突，绝不覆盖。 */
export const flushOutbox = createAsyncThunk('train/flushOutbox', async (_: void, { getState, dispatch }) => {
  if (flushing) return;
  flushing = true;
  try {
    const state = getState() as TrainState;
    const ops = state.outbox.filter((op) => op.status === 'pending' || op.status === 'failed');
    for (const op of ops) {
      await delay(220 + Math.random() * 420);
      if (Math.random() < 0.3) {
        dispatch(opFailed({ opId: op.id, error: '写入超时（模拟远端未确认），将只重试该操作' }));
        break;
      }
      const snap = readSnapshot();
      if (op.type === 'train:create') {
        if (snap?.trains.some((item) => item.id === op.trainId)) {
          const stored = snap.trains.find((item) => item.id === op.trainId);
          dispatch(opConflict({ opId: op.id, storedRev: stored?.rev ?? 0 }));
          break;
        }
        const train = buildTrainFromOp(op);
        const nextSnap: Snapshot = {
          activeId: snap?.activeId ?? op.trainId,
          operator: snap?.operator ?? (op.payload.operator as string),
          trains: [...(snap?.trains ?? []), train]
        };
        writeSnapshot(nextSnap);
        dispatch(opSucceeded({ opId: op.id }));
      } else {
        const stored = snap?.trains.find((item) => item.id === op.trainId);
        if (!snap || !stored || stored.rev !== op.baseRev) {
          dispatch(opConflict({ opId: op.id, storedRev: stored?.rev ?? 0 }));
          break;
        }
        const updated = applyOpToTrain(stored, op, op.baseRev + 1);
        const nextSnap: Snapshot = {
          activeId: snap.activeId,
          operator: snap.operator,
          trains: snap.trains.map((item) => (item.id === op.trainId ? updated : item))
        };
        writeSnapshot(nextSnap);
        dispatch(opSucceeded({ opId: op.id }));
      }
    }
  } finally {
    flushing = false;
    writeOutbox((getState() as TrainState).outbox);
  }
});

/** 从远端快照刷新到最新（丢弃未写入的本地操作）。 */
export const refreshFromStorage = createAsyncThunk('train/refreshFromStorage', async (_: void, { dispatch }) => {
  const snap = readSnapshot();
  if (snap) {
    const migrated: Snapshot = {
      ...snap,
      operator: snap.operator ?? '发布负责人',
      trains: snap.trains.map(migrateTrain)
    };
    dispatch(replaceState({
      activeId: migrated.activeId,
      operator: migrated.operator,
      trains: migrated.trains,
      outbox: [],
      stale: null
    }));
    writeSnapshot(migrated);
    writeOutbox([]);
  } else {
    dispatch(clearStale());
  }
});

export const releaseApi = createApi({
  reducerPath: 'releaseApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getTrainHealth: builder.query<{ ready: boolean; checkedAt: string }, string>({
      queryFn: (id) => ({ data: { ready: id !== 'offline', checkedAt: new Date().toISOString() } })
    })
  })
});

export const { useGetTrainHealthQuery } = releaseApi;

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware, persistenceMiddleware)
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export type { TrainOp } from '../lib/persistence';

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem(SNAPSHOT_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as Snapshot;
      if (parsed && Array.isArray(parsed.trains) && typeof parsed.activeId === 'string') {
        const migrated: Snapshot = {
          ...parsed,
          operator: parsed.operator ?? '发布负责人',
          trains: parsed.trains.map(migrateTrain)
        };
        store.dispatch(replaceState({
          activeId: migrated.activeId,
          operator: migrated.operator,
          trains: migrated.trains,
          outbox: readOutbox(),
          stale: null
        }));
        writeSnapshot(migrated);
      }
    } catch {
      /* 快照损坏时沿用内存初始状态 */
    }
  }
  // 启动后补写：旧数据迁移 + 重试上次没写进去的操作
  void store.dispatch(flushOutbox());
  // 定时重试失败的写操作（只重试 outbox 中失败的部分）
  window.setInterval(() => void store.dispatch(flushOutbox()), 6000);
  // 其他标签页写入更高修订号时，提示刷新而不是覆盖
  window.addEventListener('storage', (event) => {
    if (event.key !== SNAPSHOT_KEY) return;
    const snap = readSnapshot();
    if (!snap) return;
    const state = store.getState().train;
    const remote = snap.trains.find((item) => item.id === state.activeId);
    const local = state.trains.find((item) => item.id === state.activeId);
    if (remote && local && remote.rev > local.rev) {
      store.dispatch(setStale({ trainId: remote.id, storedRev: remote.rev }));
    }
  });
}
