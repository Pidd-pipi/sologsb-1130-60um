/**
 * 拍摄进度：由实拍张数与废帧数计算镜头完成百分比与剩余张数。
 * 被 / 与 /progress 消费。
 * 进度只累计「已确认」的实拍记录；帧序或曝光改动后记录被作废为待确认，
 * 需授权持有人重新确认后才重新计入进度。
 * 实拍记录存放在 takeCache 共享缓存里，store 层作废后各页面看到同一份台账。
 */
import { computed } from 'vue';
import * as api from '../db/api';
import { useShotStore } from '../stores/shotStore';
import { usePermitStore } from '../stores/permitStore';
import { durationToFrames } from '../utils/frameMath';
import { takesCache, takesLoading, refreshTakesCache } from './takeCache';
import type { Shot } from '../types/shot';
import type { TakeLog, WasteBucket } from '../types/take';
import { createEmptyTake } from '../types/take';

export interface ShotProgressSummary {
  shotId: number;
  code: string;
  planned: number;
  taken: number;
  wasted: number;
  remaining: number;
  percent: number;
  /** 待确认张数（帧序/曝光改动后作废、尚未重新确认的部分） */
  pending: number;
}

/** 纯函数：按实拍张数/废帧数算进度 */
export function computeProgress(planned: number, taken: number, wasted: number) {
  const total = Math.max(1, Math.floor(planned));
  const done = Math.max(0, Math.floor(taken));
  const bad = Math.max(0, Math.floor(wasted));
  const remaining = Math.max(0, total - done);
  const percent = Math.min(100, Math.round((done / total) * 100));
  return { planned: total, taken: done, wasted: bad, remaining, percent };
}

export function useProgress() {
  const shotStore = useShotStore();
  const permitStore = usePermitStore();
  const takes = takesCache;
  const loading = takesLoading;

  const summaries = computed<ShotProgressSummary[]>(() =>
    shotStore.shots.map((shot) => {
      const planned = durationToFrames(shot.durationSec, shot.fps);
      const rows = takes.value.filter((t) => t.shotId === shot.id);
      const confirmedRows = rows.filter((r) => r.confirmed);
      const taken = confirmedRows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
      const wasted = confirmedRows.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
      const pending = rows.filter((r) => !r.confirmed).reduce((sum, r) => sum + (r.takenFrames || 0), 0);
      const p = computeProgress(planned, taken, wasted);
      return { shotId: shot.id ?? 0, code: shot.code, ...p, pending };
    }),
  );

  const overall = computed(() => {
    const planned = summaries.value.reduce((s, x) => s + x.planned, 0);
    const taken = summaries.value.reduce((s, x) => s + x.taken, 0);
    const wasted = summaries.value.reduce((s, x) => s + x.wasted, 0);
    const remaining = summaries.value.reduce((s, x) => s + x.remaining, 0);
    const pending = summaries.value.reduce((s, x) => s + x.pending, 0);
    const percent = planned ? Math.min(100, Math.round((taken / planned) * 100)) : 0;
    return { planned, taken, wasted, remaining, pending, percent };
  });

  /** 废帧分布：按张数区间分桶 */
  const wasteBuckets = computed<WasteBucket[]>(() => {
    const buckets: WasteBucket[] = [
      { label: '0 张', count: 0 },
      { label: '1-2 张', count: 0 },
      { label: '3-5 张', count: 0 },
      { label: '6 张以上', count: 0 },
    ];
    for (const row of takes.value) {
      const n = row.wastedFrames || 0;
      if (n === 0) buckets[0].count += 1;
      else if (n <= 2) buckets[1].count += 1;
      else if (n <= 5) buckets[2].count += 1;
      else buckets[3].count += 1;
    }
    return buckets;
  });

  async function loadTakes() {
    await refreshTakesCache();
  }

  function emptyTake(shot: Shot): TakeLog {
    const planned = durationToFrames(shot.durationSec, shot.fps);
    const rows = takes.value.filter((t) => t.shotId === shot.id && t.confirmed);
    const taken = rows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
    const wasted = rows.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
    const p = computeProgress(planned, taken, wasted);
    return { ...createEmptyTake(shot.id ?? 0, shot.code), remainingFrames: p.remaining, percent: p.percent };
  }

  /**
   * 登记一条实拍记录，并回写镜头完成百分比。
   * 只有授权持有人能登记；登记即确认（确认人记为当前持有人）。
   */
  async function registerTake(shot: Shot, date: string, takenFrames: number, wastedFrames: number) {
    const shotId = shot.id ?? 0;
    await permitStore.assertHolder(shotId, '登记实拍');
    const now = Date.now();
    const row: TakeLog = {
      date,
      shotCode: shot.code,
      shotId,
      takenFrames,
      wastedFrames,
      remainingFrames: 0,
      percent: 0,
      confirmed: true,
      confirmedBy: permitStore.operator,
      confirmedAt: now,
      invalidReason: '',
      invalidatedAt: 0,
      updatedAt: now,
    };
    const { id, percent } = await api.addTakeAndRecalc(row);
    await loadTakes();
    shotStore.applyProgressSnapshot(shotId, percent);
    return { ...row, id };
  }

  /**
   * 持有人重新确认被作废的实拍记录；不传 ids 表示确认该镜头全部待确认记录。
   * 确认后进度立刻重算。返回重算后的完成百分比。
   */
  async function confirmTakes(shot: Shot, ids?: number[]): Promise<number> {
    const shotId = shot.id ?? 0;
    await permitStore.assertHolder(shotId, '确认实拍进度');
    // 目标直接从库里取，避免缓存滞后导致漏确认
    const targets = (ids ?? (await api.listTakesByShot(shotId)).filter((t) => !t.confirmed).map((t) => t.id ?? -1)).filter(
      (id) => id >= 0,
    );
    if (!targets.length) return -1;
    const percent = await api.confirmTakes(shotId, targets, permitStore.operator);
    await loadTakes();
    shotStore.applyProgressSnapshot(shotId, percent);
    return percent;
  }

  async function removeTake(id: number) {
    const row = takes.value.find((t) => t.id === id);
    const percent = await api.deleteTakeAndRecalc(id, row?.shotId);
    await loadTakes();
    if (row) shotStore.applyProgressSnapshot(row.shotId, percent);
  }

  return {
    takes,
    loading,
    summaries,
    overall,
    wasteBuckets,
    loadTakes,
    emptyTake,
    registerTake,
    confirmTakes,
    removeTake,
    computeProgress,
  };
}
