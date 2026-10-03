import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Badge, Button, Card, Group, Progress, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useForm } from 'react-hook-form';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  activateTrain,
  confirmGate,
  createTrain,
  flushOutbox,
  reorderGates,
  refreshFromStorage,
  resolveBlocker,
  setFreeze,
  setOperator,
  useGetTrainHealthQuery,
  type AppDispatch,
  type RepositoryGate,
  type RootState,
  type TrainOp
} from '../store';

const schema = z.object({
  name: z.string().min(3, '发布列车名称至少3个字符'),
  freezeAt: z.string().min(5, '请填写冻结时间')
});

const OP_LABELS: Record<TrainOp['type'], string> = {
  'gate:confirm': '门禁确认',
  'blocker:resolve': '阻断关闭',
  'train:status': '状态调整',
  'gates:reorder': '顺序调整',
  'train:create': '创建列车'
};

const OP_STATUS_COLOR: Record<TrainOp['status'], string> = {
  pending: 'yellow',
  failed: 'red',
  conflict: 'red',
  written: 'green'
};

function SortableGate({ gate, onConfirm, disabled }: { gate: RepositoryGate; onConfirm: () => void; disabled: boolean }) {
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
          <Button size="xs" variant="light" onClick={onConfirm} disabled={disabled || gate.status === 'confirmed'}>确认门禁</Button>
          <Button size="xs" variant="subtle" {...attributes} {...listeners}>拖拽排序</Button>
        </Group>
      </Group>
    </Card>
  );
}

export default function Home() {
  const dispatch = useDispatch<AppDispatch>();
  const state = useSelector((root: { train: RootState['train'] }) => root.train);
  const train = state.trains.find((item) => item.id === state.activeId) ?? state.trains[0];
  const { data: health, isLoading: healthLoading } = useGetTrainHealthQuery(train?.id ?? 'offline');
  const sensors = useSensors(useSensor(PointerSensor));
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { name: '', freezeAt: '2026-10-02 18:00' } });

  if (!train) return null;

  const unconfirmed = train.gates.filter((item) => item.status !== 'confirmed');
  const openBlockers = train.blockers.filter((item) => !item.resolved);
  const eligible = train.gates.length > 0 && unconfirmed.length === 0 && openBlockers.length === 0;
  const remoteReady = health?.ready === true;
  const stale = state.stale?.trainId === train.id;
  const freezeBlocked = !eligible || !remoteReady || stale;
  const pendingOps = state.outbox.filter((item) => item.status === 'pending' || item.status === 'failed' || item.status === 'conflict');

  function onDragEnd(event: DragEndEvent) {
    if (stale) return;
    if (event.over && event.active.id !== event.over.id) dispatch(reorderGates({ activeId: String(event.active.id), overId: String(event.over.id) }));
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <Text className="eyebrow">RELEASE TRAIN / PORT 62018</Text>
          <Title order={1}>开源项目发布列车准备台</Title>
          <Text>跨仓库版本、依赖、阻断项和门禁确认集中处理。任何未确认门禁都会阻止冻结。</Text>
        </div>
        <Group>
          <Badge size="xl" color="gray" variant="filled">修订号 rev.{train.rev}</Badge>
          <Badge size="xl" color={train.status === 'frozen' ? 'blue' : train.status === 'rolled-back' ? 'red' : 'yellow'}>{train.status}</Badge>
        </Group>
      </header>

      {stale && (
        <Alert mb="xl" color="red" variant="filled" title="其他标签页已更新，为避免覆盖对方的门禁与阻断，请先刷新">
          <Group justify="space-between">
            <Text size="sm">
              远端已把「{train.name}」写入到修订号 {state.stale?.storedRev}（当前标签页为 rev.{train.rev}）。继续写入会盖掉对方刚确认的门禁和关闭的阻断，已暂停写入。
            </Text>
            <Button color="white" variant="filled" onClick={() => dispatch(refreshFromStorage())}>刷新到最新</Button>
          </Group>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, md: 4 }} mb="xl">
        <Card withBorder><Text size="xs">冻结时间</Text><Title order={3}>{train.freezeAt}</Title></Card>
        <Card withBorder>
          <Text size="xs">门禁通过</Text>
          <Title order={3}>{train.gates.filter((item) => item.status === 'confirmed').length}/{train.gates.length}</Title>
          <Progress mt="sm" value={train.gates.length ? train.gates.filter((item) => item.status === 'confirmed').length / train.gates.length * 100 : 0} />
        </Card>
        <Card withBorder><Text size="xs">未关闭阻断项</Text><Title order={3} c={openBlockers.length ? 'red' : 'green'}>{openBlockers.length}</Title></Card>
        <Card withBorder>
          <Text size="xs">远端检查</Text>
          <Title order={3}>{healthLoading ? '检查中…' : remoteReady ? '可达' : '未就绪'}</Title>
        </Card>
      </SimpleGrid>

      <Card withBorder mb="xl">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={3}>冻结资格</Title>
            <Text size="sm" c="dimmed" mt="xs">资格按门禁和阻断项实时计算，任一项改动立即重算；远端检查未回来前不可冻结。</Text>
          </div>
          <Badge size="xl" color={eligible ? 'green' : 'red'}>{eligible ? '合格' : '不合格'}</Badge>
        </Group>
        {!eligible && (
          <Stack gap="xs" mt="md">
            {unconfirmed.map((item) => <Text key={item.id} size="sm" c="red">门禁未确认：{item.repository}（{item.status}）</Text>)}
            {openBlockers.map((item) => <Text key={item.id} size="sm" c="red">阻断未关闭：{item.title}</Text>)}
          </Stack>
        )}
        {!remoteReady && <Text size="sm" c="orange" mt="md">远端健康检查尚未返回，冻结已临时挡住。</Text>}
      </Card>

      <div className="layout">
        <Stack>
          <Card withBorder>
            <Group justify="space-between" mb="md"><Title order={3}>跨仓库依赖门禁</Title><Text size="sm" c="dimmed">拖动调整分批发布顺序</Text></Group>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={train.gates.map((item) => item.id)} strategy={verticalListSortingStrategy}>
                <Stack>{train.gates.map((gate) => <SortableGate key={gate.id} gate={gate} disabled={stale} onConfirm={() => dispatch(confirmGate(gate.id))} />)}</Stack>
              </SortableContext>
            </DndContext>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">阻断问题</Title>
            {train.blockers.map((item) => (
              <Group key={item.id} justify="space-between" className="row">
                <div>
                  <Badge color={item.severity === 'critical' ? 'red' : 'yellow'}>{item.severity}</Badge>
                  <Text component="span" ml="sm" td={item.resolved ? 'line-through' : undefined}>{item.title}</Text>
                </div>
                <Button variant="subtle" disabled={stale || item.resolved} onClick={() => dispatch(resolveBlocker(item.id))}>关闭</Button>
              </Group>
            ))}
          </Card>
        </Stack>

        <Stack>
          <Card withBorder>
            <Title order={3}>发布控制</Title>
            <Text size="sm" c="dimmed" mb="md">冻结仅在门禁与阻断全部就绪、且远端检查可达时可用；审计会记录操作人和修订号。</Text>
            <Stack gap="xs">
              <TextInput label="操作人" value={state.operator} onChange={(event) => dispatch(setOperator(event.currentTarget.value))} />
              <Group>
                <Button
                  onClick={() => dispatch(setFreeze('frozen'))}
                  disabled={freezeBlocked}
                  title={!eligible ? '门禁或阻断未就绪' : !remoteReady ? '远端检查未返回' : stale ? '请先刷新' : '冻结列车'}
                >冻结列车</Button>
                <Button color="red" variant="light" disabled={stale} onClick={() => dispatch(setFreeze('rolled-back'))}>标记回滚</Button>
                <Button variant="default" disabled={stale} onClick={() => dispatch(setFreeze('preparing'))}>回到准备</Button>
              </Group>
            </Stack>
          </Card>

          {pendingOps.length > 0 && (
            <Card withBorder>
              <Group justify="space-between" mb="md">
                <Title order={3}>写入队列</Title>
                <Button size="xs" variant="light" onClick={() => dispatch(flushOutbox())}>重试失败项</Button>
              </Group>
              <Stack gap="xs">
                {pendingOps.map((item) => (
                  <Group key={item.id} justify="space-between">
                    <Text size="sm">{OP_LABELS[item.type]} · 基准 rev.{item.baseRev}{item.retries > 0 ? ` · 重试 ${item.retries}` : ''}</Text>
                    <Badge color={OP_STATUS_COLOR[item.status]}>{item.status === 'pending' ? '写入中' : item.status === 'failed' ? '失败待重试' : item.status === 'conflict' ? '冲突' : '已写入'}</Badge>
                  </Group>
                ))}
              </Stack>
            </Card>
          )}

          <Card withBorder>
            <Title order={3} mb="md">新建发布列车</Title>
            <form onSubmit={form.handleSubmit((values) => { dispatch(createTrain(values)); form.reset(); })}>
              <Stack>
                <TextInput label="列车名称" {...form.register('name')} error={form.formState.errors.name?.message} />
                <TextInput label="冻结时间" {...form.register('freezeAt')} error={form.formState.errors.freezeAt?.message} />
                <Button type="submit" disabled={stale}>创建并切换</Button>
              </Stack>
            </form>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">审计历史</Title>
            <Stack gap="xs">{train.audit.slice(0, 8).map((item) => <Text key={item.id} size="sm"><b>{item.at}</b> · {item.text}</Text>)}</Stack>
          </Card>

          <Card withBorder>
            <Title order={3} mb="md">其他列车</Title>
            {state.trains.map((item) => <Button key={item.id} fullWidth variant={item.id === train.id ? 'filled' : 'subtle'} mb="xs" onClick={() => dispatch(activateTrain(item.id))}>{item.name} · rev.{item.rev}</Button>)}
          </Card>
        </Stack>
      </div>
    </main>
  );
}
