/**
 * 拍摄进度：由实拍张数与废帧数计算镜头完成百分比与剩余张数。
 * 被 / 与 /progress 消费。
 *
 * 权限：只有镜头当前的拍摄授权持有人可以登记 / 删除实拍张数；
 * 任一实拍变动都在原子事务内写入，并使已确认进度作废、需持有人重新确认。
 */
import { computed, ref } from 'vue';
import * as api from '../db/api';
import { useShotStore } from '../stores/shotStore';
import { useAuthStore } from '../stores/authStore';
import { assertHolder } from '../utils/permission';
import { durationToFrames } from '../utils/frameMath';
import type { Shot } from '../types/shot';
import { attestProgress } from '../types/shot';
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
  /** 拍摄授权持有人 */
  holder: string;
  /** 实拍进度已由持有人确认且未作废 */
  confirmed: boolean;
  /** 曾确认过，但帧序/曝光或张数已变动，确认已作废 */
  stale: boolean;
  /** 最近确认时间戳 */
  confirmedAt: number;
  /** 最近确认人 */
  confirmedBy: string;
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
  const auth = useAuthStore();
  const takes = ref<TakeLog[]>([]);
  const loading = ref(false);

  const summaries = computed<ShotProgressSummary[]>(() =>
    shotStore.shots.map((shot) => {
      const planned = durationToFrames(shot.durationSec, shot.fps);
      const rows = takes.value.filter((t) => t.shotId === shot.id);
      const taken = rows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
      const wasted = rows.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
      const p = computeProgress(planned, taken, wasted);
      const att = attestProgress(shot, taken, wasted);
      return {
        shotId: shot.id ?? 0,
        code: shot.code,
        ...p,
        holder: shot.authHolder ?? '',
        confirmed: att.confirmed,
        stale: att.stale,
        confirmedAt: shot.confirmedAt ?? 0,
        confirmedBy: shot.confirmedBy ?? '',
      };
    }),
  );

  const overall = computed(() => {
    const planned = summaries.value.reduce((s, x) => s + x.planned, 0);
    const taken = summaries.value.reduce((s, x) => s + x.taken, 0);
    const wasted = summaries.value.reduce((s, x) => s + x.wasted, 0);
    const remaining = summaries.value.reduce((s, x) => s + x.remaining, 0);
    const percent = planned ? Math.min(100, Math.round((taken / planned) * 100)) : 0;
    return { planned, taken, wasted, remaining, percent };
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
    loading.value = true;
    try {
      takes.value = await api.listTakes();
    } finally {
      loading.value = false;
    }
  }

  function emptyTake(shot: Shot): TakeLog {
    const planned = durationToFrames(shot.durationSec, shot.fps);
    const rows = takes.value.filter((t) => t.shotId === shot.id);
    const taken = rows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
    const wasted = rows.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
    const p = computeProgress(planned, taken, wasted);
    return { ...createEmptyTake(shot.id ?? 0, shot.code), remainingFrames: p.remaining, percent: p.percent };
  }

  /**
   * 登记一条实拍记录（持有人专属）：原子写入实拍记录与镜头进度，
   * 写失败时事务回滚，授权与实拍都恢复原样并抛出，由页面提示。
   */
  async function registerTake(shot: Shot, date: string, takenFrames: number, wastedFrames: number) {
    assertHolder(shot, auth.operator, '登记实拍张数');
    const planned = durationToFrames(shot.durationSec, shot.fps);
    const rows = takes.value.filter((t) => t.shotId === shot.id);
    const prevTaken = rows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
    const prevWasted = rows.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
    const p = computeProgress(planned, prevTaken + takenFrames, prevWasted + wastedFrames);
    const row: TakeLog = {
      date,
      shotCode: shot.code,
      shotId: shot.id ?? 0,
      takenFrames,
      wastedFrames,
      remainingFrames: p.remaining,
      percent: p.percent,
      registeredBy: auth.operator,
      updatedAt: Date.now(),
    };
    const { id, shot: savedShot } = await api.registerTakeAtomic(row);
    takes.value = [{ ...row, id }, ...takes.value];
    shotStore.mergeShot(savedShot);
    return { ...row, id };
  }

  /** 删除一条实拍记录（持有人专属，原子回滚） */
  async function removeTake(id: number) {
    const row = takes.value.find((t) => t.id === id);
    if (row) {
      const shot = shotStore.byId(row.shotId);
      assertHolder(shot, auth.operator, '删除实拍记录');
    }
    const shotId = await api.deleteTakeAtomic(id);
    takes.value = takes.value.filter((t) => t.id !== id);
    // 原子删除内部已回写镜头；刷新该镜头快照到最新
    if (typeof shotId === 'number') {
      const fresh = await api.getShot(shotId);
      if (fresh) shotStore.mergeShot(fresh);
    }
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
    removeTake,
    computeProgress,
  };
}
