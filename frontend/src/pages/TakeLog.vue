<script setup lang="ts">
/**
 * 实拍记录：登记当日实拍张数与废帧数，自动回写镜头完成百分比并提示剩余张数。
 * 消费 TakeLog、Shot；复用 ShotProgress 与 useProgress。
 * 登记与重新确认需要拍摄授权：只有当前持有人能操作；
 * 帧序或曝光改动后被作废的记录在这里由持有人重新确认。
 */
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useShotStore } from '../stores/shotStore';
import { usePermitStore } from '../stores/permitStore';
import { useProgress } from '../hooks/useProgress';
import { usePermit } from '../hooks/usePermit';
import { formatDateTime, today } from '../utils/format';
import ShotProgress from '../components/common/ShotProgress.vue';
import StatusTag from '../components/common/StatusTag.vue';
import EmptyState from '../components/common/EmptyState.vue';
import type { TakeLog } from '../types/take';

const shotStore = useShotStore();
const permitStore = usePermitStore();
const { shots } = storeToRefs(shotStore);
const { takes, summaries, overall, wasteBuckets, loadTakes, registerTake, confirmTakes, removeTake, loading } = useProgress();
const { guarded } = usePermit();

const selectedShotId = ref<number | null>(null);
const form = ref({ date: today(), takenFrames: 8, wastedFrames: 0 });
const feedback = ref('');

const selectedShot = computed(() => (selectedShotId.value === null ? undefined : shotStore.byId(selectedShotId.value)));
const selectedSummary = computed(() => summaries.value.find((s) => s.shotId === selectedShotId.value));
/** 当前操作人是否为所选镜头持有人：决定能否登记/确认实拍 */
const canRegister = computed(() => (selectedShotId.value === null ? false : permitStore.isHolder(selectedShotId.value)));
const holderName = computed(() => (selectedShotId.value === null ? '' : permitStore.holderOf(selectedShotId.value)));

onMounted(async () => {
  if (!shotStore.ready) await shotStore.load();
  if (!permitStore.ready) await permitStore.load();
  await loadTakes();
  const first = shots.value[0];
  if (first && typeof first.id === 'number') selectedShotId.value = first.id;
});

function flash(text: string) {
  feedback.value = text;
  window.setTimeout(() => {
    if (feedback.value === text) feedback.value = '';
  }, 3200);
}

/** 需要授权的操作统一走这里：权限拒绝时把文案 flash 出来 */
async function runGuarded(fn: () => Promise<unknown>, okText: string) {
  const denied = await guarded(fn);
  if (denied) {
    flash(denied);
    return;
  }
  flash(okText);
}

async function submit() {
  const shot = selectedShot.value;
  if (!shot) {
    flash('请先选择镜头');
    return;
  }
  const taken = Math.max(0, Math.floor(form.value.takenFrames));
  const wasted = Math.max(0, Math.floor(form.value.wastedFrames));
  if (taken <= 0) {
    flash('实拍张数需大于 0');
    return;
  }
  if (wasted > taken) {
    flash('废帧数不能多于实拍张数');
    return;
  }
  await runGuarded(async () => {
    await registerTake(shot, form.value.date, taken, wasted);
  }, `${shot.code} 已登记 ${taken} 张，完成度回写为 ${selectedSummary.value?.percent ?? 0}%`);
}

/** 持有人重新确认一条被作废的实拍记录 */
async function confirmRow(row: TakeLog) {
  if (typeof row.id !== 'number') return;
  const shot = shotStore.byId(row.shotId);
  if (!shot) return;
  await runGuarded(async () => {
    await confirmTakes(shot, [row.id as number]);
  }, `${row.shotCode} 该条实拍已重新确认，进度已重算`);
}

/** 持有人一键确认当前镜头的全部待确认记录 */
async function confirmAllForSelected() {
  const shot = selectedShot.value;
  if (!shot) return;
  const count = selectedSummary.value?.pending ?? 0;
  await runGuarded(() => confirmTakes(shot), `${shot.code} 已重新确认 ${count} 张，进度已重算`);
}

async function removeRow(row: TakeLog) {
  if (typeof row.id !== 'number') return;
  await removeTake(row.id);
  flash('已删除该条实拍记录并重算进度');
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>实拍记录</h1>
        <p class="sub">登记当日实拍张数与废帧数，自动回写镜头完成百分比并提示剩余张数</p>
      </div>
      <div class="stat-inline">
        <span>全片完成度</span>
        <strong>{{ overall.percent }}%</strong>
        <span>待拍 {{ overall.remaining }} 张</span>
        <span v-if="overall.pending" class="pending-inline">待确认 {{ overall.pending }} 张</span>
      </div>
    </header>

    <p v-if="feedback" class="feedback" data-testid="take-feedback">{{ feedback }}</p>

    <EmptyState v-if="!shots.length" title="还没有镜头" description="请先到「新建镜头」创建镜头，再登记实拍张数。" />

    <template v-else>
      <div class="two-panel">
        <div class="panel">
          <div class="panel-head">
            <h2>登记实拍</h2>
            <div class="head-tags">
              <span v-if="selectedShot" class="holder-tag" data-testid="take-holder">持有人：{{ holderName || '待认领' }}</span>
              <StatusTag v-if="selectedShot" :status="selectedShot.status" />
            </div>
          </div>
          <p v-if="selectedShot && !canRegister" class="muted permit-hint">
            只有持有人 {{ holderName || '（待认领）' }} 能登记 {{ selectedShot.code }} 的实拍张数；交接或认领请到镜头详情页。
          </p>
          <div class="form-grid">
            <label class="field">
              <span>镜头</span>
              <select v-model.number="selectedShotId" data-testid="take-shot-select">
                <option v-for="s in shots" :key="s.id" :value="s.id">{{ s.code }} · {{ s.sceneName }}</option>
              </select>
            </label>
            <label class="field"><span>拍摄日期</span><input v-model="form.date" type="date" :disabled="!canRegister" data-testid="take-log-date" /></label>
            <label class="field">
              <span>实拍张数</span>
              <input v-model.number="form.takenFrames" type="number" min="1" max="2000" step="1" :disabled="!canRegister" data-testid="take-log-taken" />
            </label>
            <label class="field">
              <span>废帧数</span>
              <input v-model.number="form.wastedFrames" type="number" min="0" max="500" step="1" :disabled="!canRegister" data-testid="take-log-wasted" />
            </label>
          </div>
          <div class="actions">
            <button type="button" class="btn primary" :disabled="!canRegister" data-testid="take-log-submit" @click="submit">登记实拍</button>
            <button
              v-if="selectedSummary && selectedSummary.pending > 0"
              type="button"
              class="btn"
              :disabled="!canRegister"
              data-testid="take-confirm-selected"
              @click="confirmAllForSelected"
            >
              确认本镜头全部待确认（{{ selectedSummary.pending }} 张）
            </button>
            <span class="muted" v-if="selectedSummary">
              计划 {{ selectedSummary.planned }} 张 · 已拍 {{ selectedSummary.taken }} 张 · 剩余 {{ selectedSummary.remaining }} 张
              <template v-if="selectedSummary.pending"> · 待确认 {{ selectedSummary.pending }} 张</template>
            </span>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h2>当前镜头进度</h2><span class="muted">{{ loading ? '读取中…' : '数据来自 IndexedDB' }}</span></div>
          <ShotProgress
            v-if="selectedSummary"
            :code="selectedSummary.code"
            :status="selectedShot?.status ?? ''"
            :planned="selectedSummary.planned"
            :taken="selectedSummary.taken"
            :wasted="selectedSummary.wasted"
            :remaining="selectedSummary.remaining"
            :percent="selectedSummary.percent"
            :pending="selectedSummary.pending"
          />
          <p v-else class="muted">请选择镜头。</p>

          <div class="waste">
            <div class="waste-title">废帧分布（按每条记录的张数分桶）</div>
            <div class="waste-bars">
              <div v-for="b in wasteBuckets" :key="b.label" class="waste-item">
                <span class="waste-label">{{ b.label }}</span>
                <div class="waste-bar"><div class="waste-fill" :style="{ width: Math.min(100, b.count * 20) + '%' }"></div></div>
                <span class="waste-count">{{ b.count }} 条</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>实拍记录清单</h2><span class="muted">共 {{ takes.length }} 条 · 进度只累计已确认张数</span></div>
        <table v-if="takes.length" class="table" data-testid="take-table">
          <thead>
            <tr><th>拍摄日期</th><th>镜号</th><th>实拍张数</th><th>废帧数</th><th>剩余张数</th><th>完成百分比</th><th>确认状态</th><th>确认人</th><th>登记时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in takes" :key="row.id" :class="{ stale: !row.confirmed }">
              <td class="mono">{{ row.date }}</td>
              <td class="mono">{{ row.shotCode }}</td>
              <td>{{ row.takenFrames }}</td>
              <td>{{ row.wastedFrames }}</td>
              <td>{{ row.remainingFrames }}</td>
              <td>{{ row.percent }}%</td>
              <td>
                <span v-if="row.confirmed" class="tag ok">已确认</span>
                <span v-else class="tag stale" :title="row.invalidReason ? `作废原因：${row.invalidReason}` : ''">待确认{{ row.invalidReason ? `（${row.invalidReason}）` : '' }}</span>
              </td>
              <td>{{ row.confirmedBy || '—' }}</td>
              <td class="muted">{{ formatDateTime(row.updatedAt) }}</td>
              <td class="row-actions">
                <button
                  v-if="!row.confirmed"
                  type="button"
                  class="btn tiny"
                  :disabled="!permitStore.isHolder(row.shotId)"
                  data-testid="take-row-confirm"
                  @click="confirmRow(row)"
                >
                  确认
                </button>
                <button type="button" class="btn tiny danger" @click="removeRow(row)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else title="还没有实拍记录" description="在上方选择镜头并登记当日实拍张数。" />
      </div>
    </template>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
}
h1 {
  margin: 0;
  font-size: 22px;
}
.sub {
  margin: 4px 0 0;
  color: #6b7686;
  font-size: 13px;
}
.stat-inline {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 13px;
  color: #5a6472;
}
.stat-inline strong {
  font-size: 20px;
  color: #2f6fed;
}
.two-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 1100px) {
  .two-panel {
    grid-template-columns: 1fr;
  }
}
.panel {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 16px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.panel-head h2 {
  margin: 0;
  font-size: 16px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.field input,
.field select {
  height: 32px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
}
.actions {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 12px;
  flex-wrap: wrap;
}
.waste {
  margin-top: 18px;
}
.waste-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.waste-bars {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.waste-item {
  display: grid;
  grid-template-columns: 70px 1fr 60px;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  color: #5a6472;
}
.waste-bar {
  height: 8px;
  background: #edf0f5;
  border-radius: 6px;
  overflow: hidden;
}
.waste-fill {
  height: 100%;
  background: #d99b2b;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th,
.table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef1f6;
}
.table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 13px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.tiny {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}
.btn.danger {
  color: #c45656;
  border-color: #f0c8c8;
}
.feedback {
  margin: 0;
  background: #eef6ff;
  border: 1px solid #d3e4ff;
  color: #24559c;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}
.head-tags {
  display: flex;
  gap: 8px;
  align-items: center;
}
.holder-tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  line-height: 20px;
  background: #eef1ff;
  color: #3d4fa8;
  white-space: nowrap;
}
.permit-hint {
  margin: 0 0 10px;
}
.pending-inline {
  color: #a8730f;
  font-weight: 600;
}
.tag {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 0 8px;
  font-size: 11px;
  line-height: 20px;
  white-space: nowrap;
}
.tag.ok {
  background: #e4f5ec;
  color: #227a52;
}
.tag.stale {
  background: #fff3dc;
  color: #a8730f;
}
tr.stale td {
  color: #8a94a6;
}
.row-actions {
  display: flex;
  gap: 6px;
}
</style>
