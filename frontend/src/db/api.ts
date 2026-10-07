/** 数据访问层：所有读写都在这里收口，写入前统一脱代理 */
import { db, toPlain } from './index';
import { durationToFrames } from '../utils/frameMath';
import { assertCurrentHolder } from '../utils/permission';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';

export async function initDb(): Promise<void> {
  if (!db.isOpen()) await db.open();
}

/* ---------------- shots ---------------- */

export async function listShots(): Promise<Shot[]> {
  const rows = await db.shots.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
}

export async function getShot(id: number): Promise<Shot | undefined> {
  return db.shots.get(id);
}

export async function addShot(shot: Shot): Promise<number> {
  return db.shots.add(toPlain(shot));
}

export async function updateShot(id: number, patch: Partial<Shot>): Promise<void> {
  await db.shots.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteShot(id: number): Promise<void> {
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, async () => {
    await db.frames.where('shotId').equals(id).delete();
    await db.props.where('shotId').equals(id).delete();
    await db.takes.where('shotId').equals(id).delete();
    await db.shots.delete(id);
  });
}

/* ---------------- frames ---------------- */

export async function listFrames(shotId: number): Promise<FrameEntry[]> {
  const rows = await db.frames.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.frameNo - b.frameNo);
}

export async function listAllFrames(): Promise<FrameEntry[]> {
  return db.frames.toArray();
}

export async function addFrame(frame: FrameEntry): Promise<number> {
  return db.frames.add(toPlain(frame));
}

export async function addFrames(frames: FrameEntry[]): Promise<void> {
  if (!frames.length) return;
  await db.frames.bulkAdd(frames.map((f) => toPlain(f)));
}

export async function updateFrame(id: number, patch: Partial<FrameEntry>): Promise<void> {
  await db.frames.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function updateFrames(rows: FrameEntry[]): Promise<void> {
  await db.transaction('rw', db.frames, async () => {
    for (const row of rows) {
      if (typeof row.id !== 'number') continue;
      const { id, ...rest } = row;
      await db.frames.update(id, toPlain({ ...rest, updatedAt: Date.now() }));
    }
  });
}

export async function deleteFrame(id: number): Promise<void> {
  await db.frames.delete(id);
}

export async function replaceShotFrames(shotId: number, frames: FrameEntry[]): Promise<void> {
  const plain = frames.map((f) => toPlain(f));
  await db.transaction('rw', db.frames, async () => {
    await db.frames.where('shotId').equals(shotId).delete();
    if (plain.length) await db.frames.bulkAdd(plain);
  });
}

/* ---------------- props ---------------- */

export async function listProps(shotId: number): Promise<PropState[]> {
  const rows = await db.props.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.fromFrame - b.fromFrame || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function listAllProps(): Promise<PropState[]> {
  return db.props.toArray();
}

export async function addProp(prop: PropState): Promise<number> {
  return db.props.add(toPlain(prop));
}

export async function updateProp(id: number, patch: Partial<PropState>): Promise<void> {
  await db.props.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteProp(id: number): Promise<void> {
  await db.props.delete(id);
}

/* ---------------- takes ---------------- */

export async function listTakes(): Promise<TakeLog[]> {
  const rows = await db.takes.toArray();
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0)));
}

export async function listTakesByShot(shotId: number): Promise<TakeLog[]> {
  return db.takes.where('shotId').equals(shotId).toArray();
}

export async function addTake(take: TakeLog): Promise<number> {
  return db.takes.add(toPlain(take));
}

export async function updateTake(id: number, patch: Partial<TakeLog>): Promise<void> {
  await db.takes.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteTake(id: number): Promise<void> {
  await db.takes.delete(id);
}

/** 按实拍张数回写镜头进度（Shot 表保存完成百分比快照，便于总览页快速读取） */
export async function syncShotProgress(shotId: number, percent: number): Promise<void> {
  await db.shots.update(shotId, toPlain({ progressPercent: percent, updatedAt: Date.now() }));
}

/* ---------------- 拍摄授权 / 实拍确认（原子操作） ---------------- */

/** 汇总一条镜头的累计实拍张数与废帧数（事务内可读） */
export async function sumTakes(shotId: number): Promise<{ rows: TakeLog[]; taken: number; wasted: number }> {
  const rows = await db.takes.where('shotId').equals(shotId).toArray();
  const taken = rows.reduce((sum, r) => sum + (r.takenFrames || 0), 0);
  const wasted = rows.reduce((sum, r) => sum + (r.wastedFrames || 0), 0);
  return { rows, taken, wasted };
}

/** 纯函数：按计划/实拍张数算完成百分比 */
function percentOf(planned: number, taken: number): number {
  const total = Math.max(1, Math.floor(planned));
  return Math.min(100, Math.round((Math.max(0, taken) / total) * 100));
}

/**
 * 整段帧序落库并同步镜头帧区间、时长、实拍百分比。
 * 帧/镜头/实拍在同一个事务内提交：任一步失败全部回滚，
 * 帧序、授权镜头与实拍进度都恢复成调用前原样。
 *
 * invalidate=true 表示本次改动涉及帧序或曝光：
 * frameVersion +1 且已确认实拍进度立即作废（progressConfirmed=false）。
 */
export async function commitShotFrames(input: {
  shotId: number;
  frames: FrameEntry[];
  invalidate: boolean;
}): Promise<Shot> {
  const { shotId, frames, invalidate } = input;
  return db.transaction('rw', db.shots, db.frames, db.takes, async () => {
    const shot = await db.shots.get(shotId);
    if (!shot) throw new Error('镜头不存在或已被删除');
    // 数据层兜底：非持有人（含授权已交出的原持有人）改帧序/曝光一律拒绝
    assertCurrentHolder(shot, invalidate ? '改动帧序或曝光' : '改动帧条目');

    const plain = frames.map((f) => toPlain(f));
    await db.frames.where('shotId').equals(shotId).delete();
    if (plain.length) await db.frames.bulkAdd(plain);

    const fps = shot.fps || 24;
    const count = plain.length;
    const seconds = Math.round((Math.max(1, count) / fps) * 1000) / 1000;
    const endFrame = shot.startFrame + count - 1;
    const { taken } = await sumTakes(shotId);
    const percent = percentOf(durationToFrames(seconds, fps), taken);

    const now = Date.now();
    const patch: Partial<Shot> = {
      durationSec: seconds,
      endFrame,
      progressPercent: percent,
      updatedAt: now,
    };
    if (invalidate) {
      patch.frameVersion = (shot.frameVersion || 0) + 1;
      patch.progressConfirmed = false;
    }
    await db.shots.update(shotId, toPlain(patch));
    return { ...shot, ...patch } as Shot;
  });
}

/**
 * 帧率 / 时长 / 起始帧变更：重排帧区间与帧序号，重算时长与实拍百分比。
 * 仅当帧规模（帧数 / 起始帧 / 帧率）真的改变时才作废旧确认并 +frameVersion；
 * 结果与现状一致（如单纯点「重算时长」）时只校正区间，不动确认状态。
 * 帧与镜头同事务提交，失败整体回滚。
 */
export async function commitShotPlan(
  shotId: number,
  change: { durationSec: number; fps: number; startFrame: number },
): Promise<{ shot: Shot; frames: FrameEntry[] }> {
  return db.transaction('rw', db.shots, db.frames, db.takes, async () => {
    const existing = await db.shots.get(shotId);
    if (!existing) throw new Error('镜头不存在或已被删除');
    assertCurrentHolder(existing, '调整帧率、时长或帧区间');

    const start = Number.isFinite(change.startFrame) && change.startFrame >= 1 ? Math.floor(change.startFrame) : 1;
    const count = durationToFrames(change.durationSec, change.fps);
    const existingCount = Math.max(0, existing.endFrame - existing.startFrame + 1);
    const structural = count !== existingCount || start !== existing.startFrame || change.fps !== existing.fps;

    let rows = (await db.frames.where('shotId').equals(shotId).toArray()).slice().sort((a, b) => a.frameNo - b.frameNo);
    if (structural) {
      rows = rows.map((row, idx) => ({ ...row, frameNo: start + idx, updatedAt: Date.now() }));
      await db.frames.where('shotId').equals(shotId).delete();
      if (rows.length) await db.frames.bulkAdd(rows.map((r) => toPlain(r)));
    }

    const { taken } = await sumTakes(shotId);
    const now = Date.now();
    const saved: Shot = {
      ...existing,
      fps: change.fps,
      durationSec: change.durationSec,
      startFrame: start,
      endFrame: start + count - 1,
      frameVersion: structural ? (existing.frameVersion || 0) + 1 : (existing.frameVersion || 0),
      progressConfirmed: structural ? false : existing.progressConfirmed,
      confirmedFrameVersion: structural ? existing.confirmedFrameVersion : existing.confirmedFrameVersion,
      progressPercent: percentOf(count, taken),
      updatedAt: now,
    };
    await db.shots.put(toPlain(saved));
    return { shot: saved, frames: rows };
  });
}

/**
 * 交接拍摄授权：原子地把持有人改成下一位，授权版本 +1。
 * 数据层兜底：必须当前持有人本人交接。只写入镜头授权本身；
 * 失败时授权保持原样（事务回滚）。
 */
export async function handoverShot(shotId: number, nextHolder: string): Promise<Shot> {
  const holder = nextHolder.trim();
  return db.transaction('rw', db.shots, async () => {
    const shot = await db.shots.get(shotId);
    if (!shot) throw new Error('镜头不存在或已被删除');
    assertCurrentHolder(shot, '交接拍摄授权');
    const now = Date.now();
    const patch: Partial<Shot> = {
      authHolder: holder,
      authVersion: (shot.authVersion || 0) + 1,
      authTransferredAt: now,
      updatedAt: now,
    };
    await db.shots.update(shotId, toPlain(patch));
    return { ...shot, ...patch } as Shot;
  });
}

/**
 * 认领挂起的拍摄授权：镜头尚无持有人时，当前操作员可认领。
 * 已有持有人时必须走 handoverShot。
 */
export async function claimShot(shotId: number, holder: string): Promise<Shot> {
  const next = holder.trim();
  return db.transaction('rw', db.shots, async () => {
    const shot = await db.shots.get(shotId);
    if (!shot) throw new Error('镜头不存在或已被删除');
    if (shot.authHolder?.trim()) {
      throw new Error(`当前由「${shot.authHolder}」接手，需由其本人交接授权`);
    }
    if (!next) throw new Error('请先设置当前操作员，再认领授权');
    const now = Date.now();
    const patch: Partial<Shot> = {
      authHolder: next,
      authVersion: (shot.authVersion || 0) + 1,
      authTransferredAt: now,
      updatedAt: now,
    };
    await db.shots.update(shotId, toPlain(patch));
    return { ...shot, ...patch } as Shot;
  });
}

/**
 * 持有人确认当前实拍进度：把当前帧序/曝光版本与累计实拍张数固化为确认快照，
 * 并重算完成百分比。镜头与实拍记录同事务读取，失败整体回滚。
 */
export async function confirmShotProgress(shotId: number, by: string): Promise<Shot> {
  return db.transaction('rw', db.shots, db.takes, async () => {
    const shot = await db.shots.get(shotId);
    if (!shot) throw new Error('镜头不存在或已被删除');
    assertCurrentHolder(shot, '确认实拍进度');
    const { taken, wasted } = await sumTakes(shotId);
    const now = Date.now();
    const patch: Partial<Shot> = {
      progressConfirmed: true,
      confirmedFrameVersion: shot.frameVersion || 0,
      confirmedTaken: taken,
      confirmedWasted: wasted,
      confirmedAt: now,
      confirmedBy: by.trim(),
      progressPercent: percentOf(durationToFrames(shot.durationSec, shot.fps), taken),
      updatedAt: now,
    };
    await db.shots.update(shotId, toPlain(patch));
    return { ...shot, ...patch } as Shot;
  });
}

/**
 * 原子登记一条实拍：写入实拍记录、回写镜头百分比，并使旧确认作废。
 * 镜头与实拍同事务提交；写入失败时实拍记录不会留下、授权镜头也不改，
 * 即「授权和实拍都恢复原样」。
 */
export async function registerTakeAtomic(take: TakeLog): Promise<{ id: number; shot: Shot }> {
  return db.transaction('rw', db.shots, db.takes, async () => {
    const shot = await db.shots.get(take.shotId);
    if (!shot) throw new Error('镜头不存在或已被删除');
    assertCurrentHolder(shot, '登记实拍张数');
    const id = await db.takes.add(toPlain(take));
    const { taken } = await sumTakes(take.shotId);
    const now = Date.now();
    const patch: Partial<Shot> = {
      progressPercent: percentOf(durationToFrames(shot.durationSec, shot.fps), taken),
      // 张数变了，已确认快照立刻对不上 → 作废，需持有人重新确认
      progressConfirmed: false,
      updatedAt: now,
    };
    await db.shots.update(take.shotId, toPlain(patch));
    return { id, shot: { ...shot, ...patch } as Shot };
  });
}

/** 原子删除一条实拍记录并重算镜头进度；失败整体回滚 */
export async function deleteTakeAtomic(id: number): Promise<number | null> {
  return db.transaction('rw', db.shots, db.takes, async () => {
    const take = await db.takes.get(id);
    if (!take) return null;
    const shot = await db.shots.get(take.shotId);
    assertCurrentHolder(shot, '删除实拍记录');
    await db.takes.delete(id);
    if (shot) {
      const { taken } = await sumTakes(take.shotId);
      await db.shots.update(
        take.shotId,
        toPlain({
          progressPercent: percentOf(durationToFrames(shot.durationSec, shot.fps), taken),
          progressConfirmed: false,
          updatedAt: Date.now(),
        }),
      );
    }
    return take.shotId;
  });
}
