import { configureStore } from '@reduxjs/toolkit';
import { releaseApi } from './api';
import { initPersistence, persistenceMiddleware } from './persistence';
import { trainSlice } from './slice';

export const store = configureStore({
  reducer: { train: trainSlice.reducer, [releaseApi.reducerPath]: releaseApi.reducer },
  middleware: (getDefault) => getDefault().concat(releaseApi.middleware, persistenceMiddleware)
});

// 第一次打开：旧数据补修订号后写回，没有数据则落库种子
initPersistence(store);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export { useGetTrainHealthQuery } from './api';
export { armWriteFailure, persistenceMiddleware, refreshFromRemote } from './persistence';
export {
  activateTrain,
  applyTrainMutation,
  commitMutation,
  computeFreezeEligibility,
  createTrain,
  makeAudit,
  trainSlice,
  writesRetry,
  initialTrainState
} from './slice';
export type {
  AuditAction,
  AuditEntry,
  HealthInfo,
  PendingChange,
  ReleaseTrain,
  RepositoryGate,
  TrainMutation,
  TrainState,
  TrainStatus
} from './slice';
