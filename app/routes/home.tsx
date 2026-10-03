import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Badge, Button, Card, Group, List, Progress, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain,
  armWriteFailure,
  commitMutation,
  computeFreezeEligibility,
  createTrain,
  refreshFromRemote,
  writesRetry,
  useGetTrainHealthQuery,
  type PendingChange,
  type RepositoryGate,
  type RootState,
  type AppDispatch
} from '../store';

const ACTOR_KEY = 'yf53-actor';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

function changeLabel(change: PendingChange): string {
  if (change.kind === 'create') return `新建发布列车「${change.snapshot?.name ?? change.trainId}」`;
  switch (change.mutation?.kind) {
    case 'gate-confirm':
      return '确认门禁并追加审计';
    case 'blocker-resolve':
      return '关闭阻断项并追加审计';
    case 'reorder':
      return '调整仓库发布顺序';
    case 'status':
      return change.mutation.status === 'frozen'
        ? '冻结发布列车'
        : change.mutation.status === 'rolled-back'
          ? '回滚发布列车'
          : '恢复到准备状态';
    default:
      return '同步修改';
  }
}

const CHANGE_STATUS: Record<PendingChange['status'], { label: string; color: string }> = {
  pending: { label: '待写入', color: 'yellow' },
  syncing: { label: '写入中', color: 'blue' },
  error: { label: '写入失败', color: 'red' },
  conflict: { label: '修订冲突', color: 'red' }
};

function SortableGate({ gate, onConfirm, locked }: { gate: RepositoryGate; onConfirm: () => void; locked: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: gate.id });
  return (
    <Card ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} withBorder>
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={700}>{gate.repository}</Text>
          <Text size="sm" c="dimmed">负责人 {gate.owner} · 依赖 {gate.dependency} · 版本 {gate.version}</Text>
        </div>
        <Group>
          <Badge color={gate.status === 'confirmed' ? 'green' : gate.status === 'blocked' ? 'red' : 'yellow'}>{gate.status}</Badge>
          <Button size="xs" variant="light" onClick={onConfirm} disabled={gate.status === 'confirmed' || locked}>确认门禁</Button>
          <Button size="xs" variant="subtle" disabled={locked} {...attributes} {...listeners}>拖拽排序</Button>
        </Group>
      </Group>
    </Card>
  );
}

export default function Home() {
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector((root: RootState) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];

  const [actor, setActor] = useState<string>(() => (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(ACTOR_KEY) ?? '' : ''));
  useEffect(() => {
    sessionStorage.setItem(ACTOR_KEY, actor);
  }, [actor]);

  const { data: healthData, isFetching: healthFetching, isError: healthError } = useGetTrainHealthQuery(train?.id ?? 'offline', {
    skip: !train
  });
  const health = !train
    ? null
    : healthFetching
      ? { status: 'loading' as const }
      : healthError
        ? { status: 'error' as const }
        : healthData?.ready
          ? { status: 'ready' as const, checkedAt: healthData.checkedAt }
          : { status: 'unhealthy' as const };

  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });

  const unresolved = train?.blockers.filter((item) => !item.resolved).length ?? 0;
  const confirmed = train?.gates.filter((item) => item.status === 'confirmed').length ?? 0;
  const eligibility = computeFreezeEligibility(train, health);

  // 远端修订号（可能由另一个标签页推高）
  const remoteRevision = train ? state.remoteSeen[train.id]?.revision ?? train.revision : 0;
  const hasConflict = Boolean(train && state.conflictTrainId === train.id);
  const stale = Boolean(train && !hasConflict && remoteRevision > train.revision);
  const actorMissing = actor.trim().length === 0;
  // 写入锁：署名缺失、修订冲突、视图过期，任一项存在都先去解决，不产生新的本地修改
  const writeLocked = actorMissing || hasConflict || stale;

  function onDragEnd(event: DragEndEvent) {
    if (writeLocked || !train) return;
    if (event.over && event.active.id !== event.over.id) {
      dispatch(commitMutation({
        trainId: train.id,
        actor: actor.trim(),
        mutation: { kind: 'reorder', activeId: String(event.active.id), overId: String(event.over.id) }
      }));
    }
  }

  if (!train) return null;

  const trainChanges = state.pendingChanges.filter((item) => item.trainId === train.id);
  const errorChanges = state.pendingChanges.filter((item) => item.status === 'error');
  const conflicting = state.pendingChanges.find((item) => item.status === 'conflict');

  return (
    <main className="shell">
      <header className="hero">
        <div><Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text><Title order={1}>开源项目发布列车准备台</Title><Text>跨仓库版本、依赖、阻断项和门禁确认集中处理。冻结资格按门禁、阻断和远端检查实时计算。</Text></div>
        <Group>
          <Badge size="lg" variant="light" color="gray">修订号 r{train.revision}{remoteRevision > train.revision ? ` / 远端 r${remoteRevision}` : ''}</Badge>
          <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
        </Group>
      </header>

      {hasConflict && (
        <Alert color="red" title="修订号冲突：远端已被另一位维护者更新" mb="md">
          <Stack gap="xs">
            <Text size="sm">本标签页的依据版本已过期：{conflicting?.detail ?? '远端修订号已变化'}，这次的修改没有写进去。请刷新拿到对方确认的门禁和阻断状态后，再重新操作（未写入的失败修改仍可在下方重试）。</Text>
            <Group><Button color="red" onClick={() => dispatch(refreshFromRemote())}>刷新到远端最新版本</Button></Group>
          </Stack>
        </Alert>
      )}
      {stale && (
        <Alert color="yellow" title={`另一个标签页已保存到 r${remoteRevision}（当前 r${train.revision}）`} mb="md">
          <Group justify="space-between">
            <Text size="sm">继续操作会因修订号不符被拒，建议先刷新；门禁确认和阻断关闭的最新结果在远端版本里。</Text>
            <Button color="yellow" variant="light" onClick={() => dispatch(refreshFromRemote())}>刷新</Button>
          </Group>
        </Alert>
      )}
      {actorMissing && !hasConflict && (
        <Alert color="blue" title="请先在右侧「发布控制」填写维护者署名" mb="md">
          <Text size="sm">所有冻结、回滚、门禁确认和阻断关闭都会连同署名写入审计，未署名前修改按钮处于禁用状态。</Text>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder><Text size="xs">门禁通过</Text><Title order={3}>{confirmed}/{train.gates.length}</Title><Progress mt="sm" value={confirmed / Math.max(train.gates.length, 1) * 100} /></Card>
        <Card withBorder><Text size="xs">未关闭阻断项</Text><Title order={3} c={unresolved ? 'red' : 'green'}>{unresolved}</Title></Card>
        <Card withBorder>
          <Text size="xs">远端健康检查</Text>
          <Title order={3} c={health?.status === 'ready' ? 'green' : health?.status === 'loading' ? 'yellow' : 'red'}>
            {health?.status === 'ready' ? '可达' : health?.status === 'loading' ? '检查中…' : health?.status === 'unhealthy' ? '不可达' : '查询失败'}
          </Title>
          {health?.status === 'loading' && <Text size="xs" c="dimmed">结果没回来前冻结被挡住</Text>}
        </Card>
      </SimpleGrid>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md"><Title order={3}>跨仓库依赖门禁</Title><Text size="sm" c="dimmed">拖动调整分批发布顺序（每项修改都带修订号提交）</Text></Group>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>{train.gates.map((gate) => (
                  <SortableGate key={gate.id} gate={gate} locked={writeLocked} onConfirm={() => dispatch(commitMutation({ trainId: train.id, actor: actor.trim(), mutation: { kind: 'gate-confirm', gateId: gate.id } }))} />
                ))}</Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => <Group key={item.id} justify="space-between" className="row"><div><Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge><Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text></div><Button variant="subtle" disabled={item.resolved || writeLocked} onClick={() => dispatch(commitMutation({ trainId: train.id, actor: actor.trim(), mutation: { kind: 'blocker-resolve', blockerId: item.id } }))}>关闭</Button></Group>)}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3} mb="md">发布控制</Title>
            <TextInput label="维护者署名（记录本标签页操作人）" placeholder="例如：陈珂" value={actor} onChange={(event) => setActor(event.currentTarget.value)} mb="md" />
            <Text size="sm" c="dimmed" mb="xs">冻结资格实时计算，一项有改动就马上重算：</Text>
            {eligibility.canFreeze
              ? <Alert color="green" mb="sm" title="门禁、阻断与远端检查全部满足，可以冻结" />
              : <Alert color="orange" mb="sm" title="暂不可冻结">
                  <List size="sm" spacing={2}>{eligibility.reasons.map((reason) => <List.Item key={reason}>{reason}</List.Item>)}</List>
                </Alert>}
            <Group>
              <Button disabled={writeLocked || !eligibility.canFreeze} onClick={() => dispatch(commitMutation({ trainId: train.id, actor: actor.trim(), mutation: { kind: 'status', status: 'frozen' } }))}>冻结列车</Button>
              <Button color="red" variant="light" disabled={writeLocked || train.status === 'rolled-back'} onClick={() => dispatch(commitMutation({ trainId: train.id, actor: actor.trim(), mutation: { kind: 'status', status: 'rolled-back' } }))}>标记回滚</Button>
              <Button variant="default" disabled={writeLocked || train.status === 'preparing'} onClick={() => dispatch(commitMutation({ trainId: train.id, actor: actor.trim(), mutation: { kind: 'status', status: 'preparing' } }))}>回到准备</Button>
            </Group>
          </Card>

          {trainChanges.length > 0 && (
            <Card withBorder>
              <Title order={3} mb="md">写入队列（本列车 {trainChanges.length} 条）</Title>
              <Stack gap="xs">
                {trainChanges.map((change) => (
                  <Group key={change.id} justify="space-between" className="row">
                    <div>
                      <Text size="sm">{changeLabel(change)}</Text>
                      {change.detail && <Text size="xs" c="red">{change.detail}</Text>}
                    </div>
                    <Badge color={CHANGE_STATUS[change.status].color}>{CHANGE_STATUS[change.status].label}</Badge>
                  </Group>
                ))}
                {errorChanges.length > 0 && (
                  <Group mt="sm">
                    <Button size="xs" color="red" variant="light" onClick={() => dispatch(writesRetry())}>只重试没写进去的 {errorChanges.length} 条</Button>
                    <Text size="xs" c="dimmed">已写入的不会重发</Text>
                  </Group>
                )}
              </Stack>
            </Card>
          )}

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={form.handleSubmit((values) => { dispatch(createTrain({ ...values, actor: actor.trim() })); form.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit" disabled={actorMissing}>{actorMissing ? '先填写维护者署名' : '创建并切换'}</Button>
              </Stack>
            </form>
            <Group mt="sm"><Button size="xs" variant="subtle" color="gray" onClick={() => armWriteFailure()}>演示：让下一次写入失败</Button></Group>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{train.audit.slice(0, 12).map((item) => (
              <Text key={item.id} size="sm"><b>{item.at}</b> · <Badge size="xs" variant="outline" color="gray" mr={4}>{item.actor}</Badge>{item.text}</Text>
            ))}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name} · r{item.revision}</Button>)}
          </Card>
        </Stack>
      </div>
    </main>
  );
}
