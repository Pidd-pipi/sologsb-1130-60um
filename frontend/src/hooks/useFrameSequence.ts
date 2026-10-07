/**
 * 帧序编排：插入 / 删除 / 移动帧并重排帧序号，联动镜头帧区间。
 * 被 /frames 与 /shots/:id 消费。
 *
 * 所有改动都经 frameStore.commit 原子提交：帧、镜头帧区间、
 * 已确认实拍进度的作废重算在同一事务内完成；非持有人会被权限拒绝。
 */
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useFrameStore } from '../stores/frameStore';
import { useShotStore } from '../stores/shotStore';
import * as api from '../db/api';
import { durationToFrames, framesToDuration } from '../utils/frameMath';
import type { FrameEntry } from '../types/frame';

export function useFrameSequence() {
  const frameStore = useFrameStore();
  const shotStore = useShotStore();
  const { frames, selectedFrameNo } = storeToRefs(frameStore);

  const shotId = computed(() => frameStore.shotId);
  const shot = computed(() => (shotId.value === null ? undefined : shotStore.byId(shotId.value)));
  const fps = computed(() => shot.value?.fps ?? 24);
  const frameCount = computed(() => frames.value.length);
  const totalDuration = computed(() => framesToDuration(frameCount.value, fps.value));
  const plannedFrames = computed(() => durationToFrames(shot.value?.durationSec ?? 0, fps.value));

  async function insertAfter(frameNo: number | null) {
    const index = frameNo === null ? frames.value.length : frames.value.findIndex((f) => f.frameNo === frameNo) + 1;
    // insertAt 内部原子提交，已同步镜头帧区间与进度作废
    await frameStore.insertAt(Math.max(0, index));
  }

  async function removeAt(frameNo: number) {
    const index = frames.value.findIndex((f) => f.frameNo === frameNo);
    if (index < 0) return;
    await frameStore.removeAt(index);
  }

  async function move(fromIndex: number, toIndex: number) {
    await frameStore.move(fromIndex, toIndex);
  }

  /**
   * 「重算时长」：从库中回读镜头与帧条目，校正条带与区间显示。
   * 不产生写入、不作废确认，因此不需要持有人权限。
   */
  async function syncShotRange() {
    if (shotId.value === null) return;
    const [freshShot, freshFrames] = await Promise.all([api.getShot(shotId.value), api.listFrames(shotId.value)]);
    if (freshShot) shotStore.mergeShot(freshShot);
    frameStore.hydrate(freshFrames);
  }

  /** 条带上的单帧曝光/位移改动 */
  async function patch(frameNo: number, patchValue: Partial<FrameEntry>) {
    await frameStore.patchFrame(frameNo, patchValue);
  }

  function select(frameNo: number | null) {
    frameStore.select(frameNo);
  }

  return {
    frames,
    selectedFrameNo,
    shot,
    fps,
    frameCount,
    totalDuration,
    plannedFrames,
    insertAfter,
    removeAt,
    move,
    patch,
    select,
    syncShotRange,
    reload: (id: number) => frameStore.loadForShot(id),
  };
}
