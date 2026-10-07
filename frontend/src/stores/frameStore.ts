/** 帧条目 store：条带选中、帧序数组、批量曝光、持久化（拍摄授权受控） */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { toPlain } from '../db';
import { assertHolder } from '../utils/permission';
import { useAuthStore } from './authStore';
import { useShotStore } from './shotStore';
import { accumulateOffsets, estimateSpeed, frameColor, framesToDuration } from '../utils/frameMath';
import type { BatchExposure, FrameEntry } from '../types/frame';
import { createEmptyFrame } from '../types/frame';

/** 本次改动是否触碰帧序（插入/删除/移动必然是） */
type MutationKind = 'sequence' | 'exposure' | 'other';

interface FrameState {
  frames: FrameEntry[];
  shotId: number | null;
  selectedFrameNo: number | null;
  dirty: boolean;
}

export const useFrameStore = defineStore('frame', {
  state: (): FrameState => ({
    frames: [],
    shotId: null,
    selectedFrameNo: null,
    dirty: false,
  }),
  getters: {
    count(state): number {
      return state.frames.length;
    },
    selected(state): FrameEntry | undefined {
      if (state.selectedFrameNo === null) return undefined;
      return state.frames.find((f) => f.frameNo === state.selectedFrameNo);
    },
    /** 全部帧的累计位移轨迹（mm） */
    offsets(state): number[] {
      return accumulateOffsets(state.frames.map((f) => f.propOffsetMm));
    },
    /** 整段帧序按张数折算的总时长（秒） */
    totalDuration(state): number {
      return Math.round(state.frames.reduce((sum, f) => sum + 1 / (f.shotCount || 1), 0) * 100) / 100;
    },
    /** 帧序在给定帧率下的实际时长（秒） */
    durationAtFps(state) {
      return (fps: number) => framesToDuration(state.frames.length, fps);
    },
  },
  actions: {
    async loadForShot(shotId: number) {
      this.shotId = shotId;
      this.frames = await api.listFrames(shotId);
      this.dirty = false;
      if (this.frames.length && !this.frames.some((f) => f.frameNo === this.selectedFrameNo)) {
        this.selectedFrameNo = this.frames[0].frameNo;
      }
    },
    /** 外部（如帧率/时长重排）原子写回后，用最新行刷新缓存 */
    hydrate(frames: FrameEntry[]) {
      this.frames = frames.map((f) => ({ ...f }));
      this.dirty = false;
    },
    select(frameNo: number | null) {
      this.selectedFrameNo = frameNo;
    },
    /**
     * 帧序/曝光改动统一入口：
     * 1. 先断言当前操作员是该镜头持有人（非持有人直接拒绝，落不了库）；
     * 2. 先在本地快照上算出新帧序；
     * 3. 原子提交帧 + 镜头帧区间 + 实拍作废重算；
     * 4. 写失败时本地帧序与镜头状态恢复原样（DB 事务已回滚）。
     */
    async commit(nextFrames: FrameEntry[], kind: MutationKind) {
      if (this.shotId === null) return;
      const shotId = this.shotId;
      const shotStore = useShotStore();
      const auth = useAuthStore();
      const shot = shotStore.byId(shotId);
      const action = kind === 'sequence' ? '改动帧序' : kind === 'exposure' ? '改动曝光' : '改动帧条目';
      assertHolder(shot, auth.operator, action);

      const ordered = nextFrames.map((f, idx) => ({
        ...toPlain(f),
        frameNo: idx + 1,
        shotId,
      }));
      const prevFrames = this.frames;
      const prevDirty = this.dirty;
      this.frames = ordered;
      this.dirty = true;
      try {
        const invalidate = kind !== 'other';
        const savedShot = await api.commitShotFrames({ shotId, frames: ordered, invalidate });
        // 用库里回读的权威行刷新（updatedAt 等）
        this.frames = await api.listFrames(shotId);
        this.dirty = false;
        shotStore.mergeShot(savedShot);
      } catch (e) {
        // 恢复本地帧序；镜头快照由 DB 事务保证未变（帧区间/进度随事务一起回滚）
        this.frames = prevFrames;
        this.dirty = prevDirty;
        throw e;
      }
    },
    async insertAt(index: number, seed?: Partial<FrameEntry>) {
      const base = createEmptyFrame(this.shotId ?? 0, index + 1);
      const anchor = this.frames[index - 1] ?? this.frames[0];
      const merged: FrameEntry = {
        ...base,
        ...(anchor
          ? {
              shotCount: anchor.shotCount,
              exposureSec: anchor.exposureSec,
              aperture: anchor.aperture,
              iso: anchor.iso,
              shutterAngle: anchor.shutterAngle,
              lighting: anchor.lighting,
            }
          : {}),
        ...seed,
        frameNo: index + 1,
        id: undefined,
      };
      const next = [...this.frames.slice(0, index), merged, ...this.frames.slice(index)].map((f, idx) => ({
        ...f,
        frameNo: idx + 1,
      }));
      await this.commit(next, 'sequence');
    },
    async removeAt(index: number) {
      if (this.frames.length <= 1) return;
      const next = this.frames
        .filter((_, i) => i !== index)
        .map((f, idx) => ({ ...f, frameNo: idx + 1 }));
      await this.commit(next, 'sequence');
    },
    async move(from: number, to: number) {
      if (from === to || from < 0 || to < 0 || from >= this.frames.length || to >= this.frames.length) return;
      const next = this.frames.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      await this.commit(
        next.map((f, idx) => ({ ...f, frameNo: idx + 1 })),
        'sequence',
      );
    },
    /** 批量套用曝光参数（持有人专属，触碰曝光 → 已确认进度作废重算） */
    async applyBatch(batch: BatchExposure, indexes?: number[]) {
      const target = indexes && indexes.length ? new Set(indexes) : null;
      const next = this.frames.map((f, idx) => {
        if (target && !target.has(idx)) return f;
        return {
          ...f,
          exposureSec: batch.exposureSec,
          aperture: batch.aperture,
          iso: batch.iso,
          shutterAngle: batch.shutterAngle,
          updatedAt: Date.now(),
        };
      });
      await this.commit(next, 'exposure');
    },
    /**
     * 就地更新单帧字段（镜头详情页表格 / 条带位移量）。
     * 帧序字段（张数）与曝光字段改动会作废旧确认；备注/位移等不影响实拍口径，不废旧确认。
     */
    async patchFrame(frameNo: number, patch: Partial<FrameEntry>) {
      const idx = this.frames.findIndex((f) => f.frameNo === frameNo);
      if (idx < 0) return;
      const next = { ...this.frames[idx], ...patch, updatedAt: Date.now() };
      const list = this.frames.map((f, i) => (i === idx ? next : f));
      const touchesAuth = Object.keys(patch).some(
        (k) => k === 'shotCount' || ['exposureSec', 'aperture', 'iso', 'shutterAngle'].includes(k),
      );
      await this.commit(list, touchesAuth ? 'exposure' : 'other');
    },
    /** 条带单帧颜色：按曝光与位移量着色 */
    colorOf(frame: FrameEntry): string {
      return frameColor({ propOffsetMm: frame.propOffsetMm, exposureSec: frame.exposureSec });
    },
    speedOf(frame: FrameEntry, fps: number): number {
      return estimateSpeed(frame.propOffsetMm, fps);
    },
  },
});
