/** 镜头 store：镜头增删改查、按帧率与时长排帧区间、拍摄授权交接与实拍确认 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { toPlain } from '../db';
import { assertHolder, isPermissionDenied } from '../utils/permission';
import { useAuthStore } from './authStore';
import { useFrameStore } from './frameStore';
import { buildFrameRange, framesToDuration } from '../utils/frameMath';
import type { Shot } from '../types/shot';
import { createEmptyShot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import { createEmptyFrame } from '../types/frame';

interface ShotState {
  shots: Shot[];
  currentId: number | null;
  ready: boolean;
}

export const useShotStore = defineStore('shot', {
  state: (): ShotState => ({
    shots: [],
    currentId: null,
    ready: false,
  }),
  getters: {
    current(state): Shot | undefined {
      return state.shots.find((s) => s.id === state.currentId);
    },
    byId(state) {
      return (id: number) => state.shots.find((s) => s.id === id);
    },
    totalPlannedFrames(state): number {
      return state.shots.reduce((sum, s) => sum + (s.endFrame - s.startFrame + 1), 0);
    },
    finishedShots(state): number {
      return state.shots.filter((s) => s.status === '已完成').length;
    },
    totalSeconds(state): number {
      return Math.round(state.shots.reduce((sum, s) => sum + framesToDuration(s.endFrame - s.startFrame + 1, s.fps), 0) * 100) / 100;
    },
  },
  actions: {
    async load() {
      try {
        this.shots = await api.listShots();
        this.ready = true;
      } catch (e) {
        this.shots = [];
        this.ready = true;
        throw e;
      }
    },
    async create(payload: Partial<Shot>): Promise<Shot> {
      const base = { ...createEmptyShot(), ...payload };
      const range = buildFrameRange(base.startFrame, base.durationSec, base.fps);
      const now = Date.now();
      // 新建镜头即发放初始拍摄授权：默认持有人=负责人，负责人留空则授权挂起，待认领
      const holder = (base.authHolder?.trim() || base.owner?.trim() || '').trim();
      const shot: Shot = toPlain({
        ...base,
        startFrame: range.startFrame,
        endFrame: range.endFrame,
        progressPercent: 0,
        authHolder: holder,
        authVersion: holder ? 1 : 0,
        authTransferredAt: holder ? now : 0,
        frameVersion: 0,
        progressConfirmed: false,
        confirmedFrameVersion: 0,
        confirmedTaken: 0,
        confirmedWasted: 0,
        confirmedAt: 0,
        confirmedBy: '',
        createdAt: now,
        updatedAt: now,
      });
      const id = await api.addShot(shot);
      const saved: Shot = { ...shot, id };
      this.shots = [...this.shots, saved].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
      this.currentId = id;
      return saved;
    },
    /**
     * 改时长/帧率/起始帧后重排帧区间（持有人专属）。
     * 帧序规模会变化 → 原子提交，已确认实拍进度作废重算；写失败整体回滚。
     */
    async update(id: number, patch: Partial<Shot>) {
      const existing = this.shots.find((s) => s.id === id);
      if (!existing) return;
      const auth = useAuthStore();
      assertHolder(existing, auth.operator, '调整帧率、时长或帧区间');
      const next = { ...existing, ...patch };
      const range = buildFrameRange(next.startFrame, next.durationSec, next.fps);
      try {
        const { shot, frames } = await api.commitShotPlan(id, {
          durationSec: next.durationSec,
          fps: next.fps,
          startFrame: range.startFrame,
        });
        this.shots = this.shots.map((s) => (s.id === id ? shot : s));
        // 帧率/时长改动会重排帧序号，缓存中的帧条目同步刷新
        if (frames.length) {
          const frameStore = useFrameStore();
          if (frameStore.shotId === id) frameStore.hydrate(frames);
        }
      } catch (e) {
        // 写失败：store 内授权与帧序恢复原样（DB 事务已回滚）
        this.shots = this.shots.map((s) => (s.id === id ? { ...existing } : s));
        if (!isPermissionDenied(e)) throw e;
      }
    },
    /**
     * 交接拍摄授权给下一位（持有人专属）。原子写镜头；
     * 写失败时授权保持原样并抛出，调用方提示。
     */
    async handover(id: number, nextHolder: string): Promise<Shot> {
      const holder = nextHolder.trim();
      if (!holder) throw new Error('请填写接手人姓名');
      const existing = this.shots.find((s) => s.id === id);
      if (!existing) throw new Error('镜头不存在');
      const auth = useAuthStore();
      assertHolder(existing, auth.operator, '交接拍摄授权');
      if (holder === existing.authHolder.trim()) {
        throw new Error(`${holder} 已经是当前持有人，无需交接`);
      }
      const saved = await api.handoverShot(id, holder);
      this.shots = this.shots.map((s) => (s.id === id ? saved : s));
      return saved;
    },
    /**
     * 认领挂起的授权（镜头尚无持有人时，任何登记过姓名的操作员都可认领）。
     */
    async claim(id: number): Promise<Shot> {
      const existing = this.shots.find((s) => s.id === id);
      if (!existing) throw new Error('镜头不存在');
      const auth = useAuthStore();
      if (!auth.operator) throw new Error('请先在顶部设置当前操作员，再认领授权');
      if (existing.authHolder.trim()) {
        throw new Error(`当前由「${existing.authHolder}」接手，需由其本人交接授权`);
      }
      const saved = await api.claimShot(id, auth.operator);
      this.shots = this.shots.map((s) => (s.id === id ? saved : s));
      return saved;
    },
    /** 持有人确认当前实拍进度（帧序/曝光或张数变动后需重新确认） */
    async confirmProgress(id: number): Promise<Shot> {
      const existing = this.shots.find((s) => s.id === id);
      if (!existing) throw new Error('镜头不存在');
      const auth = useAuthStore();
      assertHolder(existing, auth.operator, '确认实拍进度');
      const saved = await api.confirmShotProgress(id, auth.operator);
      this.shots = this.shots.map((s) => (s.id === id ? saved : s));
      return saved;
    },
    async setStatus(id: number, status: Shot['status']) {
      await api.updateShot(id, { status });
      this.shots = this.shots.map((s) => (s.id === id ? { ...s, status, updatedAt: Date.now() } : s));
    },
    async syncProgress(id: number, percent: number) {
      await api.syncShotProgress(id, percent);
      this.shots = this.shots.map((s) => (s.id === id ? { ...s, progressPercent: percent } : s));
    },
    /** 原子写操作返回的镜头快照合并进 store（不重复落库） */
    mergeShot(shot: Shot) {
      if (typeof shot.id !== 'number') return;
      this.shots = this.shots.map((s) => (s.id === shot.id ? { ...shot } : s));
    },
    async remove(id: number) {
      await api.deleteShot(id);
      this.shots = this.shots.filter((s) => s.id !== id);
      if (this.currentId === id) this.currentId = null;
    },
    /** 依据时长给出帧区间预览（不落库） */
    previewRange(startFrame: number, durationSec: number, fps: number) {
      return buildFrameRange(startFrame, durationSec, fps);
    },
  },
});

/** 新建镜头时生成首个帧条目 */
export function firstFrameOf(shot: Shot): FrameEntry {
  const frame = createEmptyFrame(shot.id ?? 0, shot.startFrame);
  return frame;
}
