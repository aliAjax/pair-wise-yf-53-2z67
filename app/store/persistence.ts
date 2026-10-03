import type { Middleware, Store } from '@reduxjs/toolkit';
import {
  applyTrainMutation,
  initialTrainState,
  trainSlice,
  changeConflict,
  changeErrored,
  changesSyncing,
  hydrate,
  pruneSynced,
  reloadState,
  remoteTrainPatched,
  remoteUpdated,
  type AuditEntry,
  type AuditAction,
  type PendingChange,
  type ReleaseTrain,
  type TrainState
} from './slice';

/**
 * 远端存储层（用 localStorage 模拟跨标签页共享的服务端文档）。
 * update 请求带修订号 CAS：远端修订号与 baseRevision 不符即冲突，整次写入被拒绝。
 */
const STORAGE_KEY = 'yf53-release-state';
const SCHEMA_VERSION = 2;

interface ServerDoc {
  version: typeof SCHEMA_VERSION;
  updatedAt: string;
  trains: ReleaseTrain[];
}

/** 演示用：让下一次落库写入失败（只影响真正写入，不影响本地乐观更新） */
let failNextWrite = false;
export function armWriteFailure() {
  failNextWrite = true;
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}

/** 旧数据没有修订号，第一次读到时给每个列车补上 revision=1，并补全审计字段 */
function normalizeAudit(raw: any): AuditEntry {
  const action: AuditAction =
    raw && typeof raw === 'object' && typeof raw.action === 'string'
      ? (raw.action as AuditAction)
      : 'note';
  return {
    id: typeof raw?.id === 'string' ? raw.id : `a-${Math.random()}`,
    at: typeof raw?.at === 'string' ? raw.at : '',
    text: typeof raw?.text === 'string' ? raw.text : '',
    actor: typeof raw?.actor === 'string' && raw.actor ? raw.actor : '（旧数据）未知维护者',
    action
  };
}

function normalizeTrain(raw: any): ReleaseTrain {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    freezeAt: String(raw.freezeAt ?? ''),
    status: raw.status === 'frozen' || raw.status === 'rolled-back' ? raw.status : 'preparing',
    gates: Array.isArray(raw.gates) ? clone(raw.gates) : [],
    blockers: Array.isArray(raw.blockers) ? clone(raw.blockers) : [],
    audit: Array.isArray(raw.audit) ? raw.audit.map(normalizeAudit) : [],
    revision: typeof raw.revision === 'number' && raw.revision > 0 ? raw.revision : 1
  };
}

function normalizeDoc(raw: any): { doc: ServerDoc; migrated: boolean } {
  // 旧版本：直接存的 TrainState（{ activeId, trains }）或裸列车数组
  let trains: unknown[] = [];
  if (Array.isArray(raw)) trains = raw;
  else if (raw && Array.isArray(raw.trains)) trains = raw.trains;
  const normalized = trains.map(normalizeTrain);
  const migrated = trains.some((item: any) => typeof item?.revision !== 'number');
  return {
    doc: { version: SCHEMA_VERSION, updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : '', trains: normalized },
    migrated
  };
}

function writeDoc(doc: ServerDoc): { ok: true } | { ok: false; reason: string } {
  try {
    if (failNextWrite) {
      failNextWrite = false;
      return { ok: false, reason: '模拟的远端写入失败（网络抖动）' };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'localStorage 写入失败' };
  }
}

function readDoc(): ServerDoc | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return normalizeDoc(JSON.parse(raw)).doc;
  } catch {
    return null;
  }
}

/** 首次打开：读旧数据并补修订号，没有任何数据则落库种子数据。返回要装进 store 的初始状态 */
export function hydrateInitialState(): TrainState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const doc: ServerDoc = {
      version: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      trains: clone(initialTrainState.trains)
    };
    writeDoc(doc);
    return clone(initialTrainState);
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return clone(initialTrainState);
  }
  const legacyActiveId = typeof parsed?.activeId === 'string' ? parsed.activeId : undefined;
  const { doc, migrated } = normalizeDoc(parsed);
  if (migrated) {
    // 旧数据第一次打开：补完修订号立刻照旧写回，之后一切按新规则走
    doc.updatedAt = new Date().toISOString();
    writeDoc(doc);
  }
  const activeId = legacyActiveId && doc.trains.some((item) => item.id === legacyActiveId)
    ? legacyActiveId
    : doc.trains[0]?.id ?? initialTrainState.activeId;
  const remoteSeen: TrainState['remoteSeen'] = {};
  for (const train of doc.trains) remoteSeen[train.id] = { revision: train.revision, updatedAt: doc.updatedAt };
  return { activeId, trains: doc.trains, pendingChanges: [], remoteSeen, conflictTrainId: null };
}

/* ---------------------------------- 队列刷新 ---------------------------------- */

let flushing = false;
let scheduled = false;

function flushQueue(store: Store) {
  if (flushing || scheduled) return;
  const state = store.getState().train as TrainState;
  if (!state.pendingChanges.some((item) => item.status === 'pending' || item.status === 'error')) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    void doFlush(store);
  }, 60);
}

async function doFlush(store: Store) {
  if (flushing) return;
  const queued = (store.getState().train as TrainState).pendingChanges.filter(
    (item) => item.status === 'pending' || item.status === 'error'
  );
  if (queued.length === 0) return;

  flushing = true;
  const synced: string[] = [];
  // 冲突只阻塞该列车自己的链条（该列车后续修改的依据修订号也已过期）；其他列车照常提交
  const blockedTrainIds = new Set<string>();
  let hardError = false;
  try {
    for (const change of queued) {
      // 上一条还没写进去就停下来，后续条目保持 pending（只重试没写进去的部分）
      const latest = (store.getState().train as TrainState).pendingChanges.find((item) => item.id === change.id);
      if (!latest || (latest.status !== 'pending' && latest.status !== 'error')) continue;
      if (blockedTrainIds.has(change.trainId)) continue;

      store.dispatch(changesSyncing({ ids: [change.id] }));
      const result = commitChange(change);

      if (result.outcome === 'error') {
        // 写入失败通常是整体存储不可用：停在第一条失败处，等用户显式重试
        store.dispatch(changeErrored({ id: change.id, detail: result.reason }));
        hardError = true;
        break;
      }
      if (result.outcome === 'conflict') {
        // 对方的标签页已经把修订号推高了：本次修改被拒，要求刷新后再处理
        blockedTrainIds.add(change.trainId);
        store.dispatch(
          changeConflict({ id: change.id, trainId: change.trainId, detail: result.reason })
        );
        continue;
      }
      synced.push(change.id);
      const committedAt = new Date().toISOString();
      store.dispatch(
        remoteUpdated({
          trainId: change.trainId,
          revision: result.revision,
          updatedAt: committedAt
        })
      );
      // 正常乐观流程下本地已领先；若本地因刷新落后（典型：失败条目在刷新后重试成功），
      // 用提交后的远端版本补丁本地视图
      const current = (store.getState().train as TrainState);
      const localTrain = current.trains.find((item) => item.id === change.trainId);
      if (!localTrain || localTrain.revision < result.revision) {
        store.dispatch(remoteTrainPatched({ train: result.train, updatedAt: committedAt }));
      }
    }
  } finally {
    if (synced.length > 0) store.dispatch(pruneSynced({ ids: synced }));
    flushing = false;
    // 失败处停下（等重试）；冲突只挡本列车，其他列车若还有排队项继续刷
    const state = store.getState().train as TrainState;
    if (
      !hardError &&
      state.pendingChanges.some(
        (item) => item.status === 'pending' && !blockedTrainIds.has(item.trainId)
      )
    ) {
      flushQueue(store);
    }
  }
}

type CommitResult =
  | { outcome: 'committed'; revision: number; train: ReleaseTrain }
  | { outcome: 'error'; reason: string }
  | { outcome: 'conflict'; reason: string };

/** 在远端文档上执行一次带 CAS 的写入；成功才落 localStorage */
function commitChange(change: PendingChange): CommitResult {
  const doc = readDoc();

  if (change.kind === 'create') {
    const nextDoc: ServerDoc = doc
      ? { ...doc, trains: [...doc.trains] }
      : { version: SCHEMA_VERSION, updatedAt: '', trains: [] };
    // create 幂等：重试时若列车已存在则视为成功，不会再造一辆
    const existing = nextDoc.trains.find((item) => item.id === change.trainId);
    if (existing) {
      return { outcome: 'committed', revision: existing.revision, train: clone(existing) };
    }
    const snapshot = clone(change.snapshot);
    if (!snapshot) return { outcome: 'error', reason: '缺少新建列车快照' };
    nextDoc.trains.push(snapshot);
    nextDoc.updatedAt = new Date().toISOString();
    const result = writeDoc(nextDoc);
    return result.ok
      ? { outcome: 'committed', revision: snapshot.revision, train: snapshot }
      : { outcome: 'error', reason: result.reason };
  }

  if (!doc) return { outcome: 'error', reason: '远端文档不存在，请刷新后重试' };
  const remoteTrain = doc.trains.find((item) => item.id === change.trainId);
  if (!remoteTrain) return { outcome: 'error', reason: '远端找不到该列车，请刷新后重试' };
  if (change.baseRevision === undefined || remoteTrain.revision !== change.baseRevision) {
    return {
      outcome: 'conflict',
      reason: `远端修订号已从 ${change.baseRevision ?? '?'} 变为 ${remoteTrain.revision}，本次修改被拒`
    };
  }
  if (!change.mutation) return { outcome: 'error', reason: '缺少变更内容' };

  const target = clone(remoteTrain);
  applyTrainMutation(target, change.mutation, change.audit ? clone(change.audit) : null);
  target.revision = remoteTrain.revision + 1;

  const nextDoc: ServerDoc = {
    ...doc,
    updatedAt: new Date().toISOString(),
    trains: doc.trains.map((item) => (item.id === target.id ? target : item))
  };
  const result = writeDoc(nextDoc);
  if (!result.ok) return { outcome: 'error', reason: result.reason };
  return { outcome: 'committed', revision: target.revision, train: target };
}

/* -------------------------------- 跨标签页监听 -------------------------------- */

let listenerInstalled = false;

function installStorageListener(store: Store) {
  if (listenerInstalled || typeof window === 'undefined') return;
  listenerInstalled = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    let parsed: any;
    try {
      parsed = JSON.parse(event.newValue);
    } catch {
      return;
    }
    const { doc } = normalizeDoc(parsed);
    const state = store.getState().train as TrainState;
    const updatedAt = doc.updatedAt || new Date().toISOString();

    for (const remoteTrain of doc.trains) {
      const localTrain = state.trains.find((item) => item.id === remoteTrain.id);
      const seen = state.remoteSeen[remoteTrain.id];
      if (!seen || seen.revision < remoteTrain.revision) {
        store.dispatch(remoteUpdated({ trainId: remoteTrain.id, revision: remoteTrain.revision, updatedAt }));
      }
      // 本地没有未提交修改时，另一个标签页的保存直接打补丁同步进来，不用等手动刷新
      const localPending = state.pendingChanges.some((item) => item.trainId === remoteTrain.id);
      if (localTrain && localTrain.revision < remoteTrain.revision && !localPending) {
        store.dispatch(remoteTrainPatched({ train: remoteTrain, updatedAt }));
      }
    }
  });
}

/* --------------------------------- 对外动作 --------------------------------- */

/** 放弃本地在途视图，按远端最新数据重开；未写进去且可重试的失败修改保留在队列里 */
export function refreshFromRemote() {
  return (_dispatch: unknown, getState: () => { train: TrainState }) => {
    const state = getState().train;
    const doc = readDoc();
    if (!doc) return;
    const activeId = doc.trains.some((item) => item.id === state.activeId)
      ? state.activeId
      : doc.trains[0]?.id ?? state.activeId;
    const dispatch = _dispatch as (action: unknown) => void;
    dispatch(reloadState({ trains: doc.trains, activeId }));
  };
}

export const persistenceMiddleware: Middleware = (store) => (next) => (action) => {
  const result = next(action);
  const { type } = action as { type?: string };
  // 队列状态相关动作走完 reducer 后，按需继续刷新
  if (typeof type === 'string' && type.startsWith(trainSlice.actions.hydrate.type.split('/')[0])) {
    flushQueue(store as Store);
  }
  return result;
};

export function initPersistence(store: Store) {
  if (typeof window === 'undefined') return;
  store.dispatch(hydrate(hydrateInitialState()));
  installStorageListener(store);
}
