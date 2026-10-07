/** 数据访问层：所有读写都在这里收口，写入前统一脱代理 */
import { db, toPlain } from './index';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type { Permit } from '../types/permit';
import { durationToFrames } from '../utils/frameMath';

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
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, db.permits, async () => {
    await db.frames.where('shotId').equals(id).delete();
    await db.props.where('shotId').equals(id).delete();
    await db.takes.where('shotId').equals(id).delete();
    await db.permits.where('shotId').equals(id).delete();
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

/**
 * 重算某镜头的实拍台账：按日期顺序累计「已确认」张数，
 * 回写每条记录的剩余张数/百分比快照与镜头完成百分比。
 * 须在 takes + shots 的事务里调用（Dexie 事务区内会自动并入当前事务）。
 */
async function recalcShotTakesLocked(shotId: number): Promise<number> {
  const shot = await db.shots.get(shotId);
  if (!shot) return 0;
  const planned = durationToFrames(shot.durationSec, shot.fps);
  const rows = await db.takes.where('shotId').equals(shotId).toArray();
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id ?? 0) - (b.id ?? 0)));
  let confirmedTaken = 0;
  for (const row of rows) {
    if (row.confirmed) confirmedTaken += row.takenFrames || 0;
    const remainingFrames = Math.max(0, planned - confirmedTaken);
    const percent = Math.min(100, Math.round((confirmedTaken / planned) * 100));
    if (typeof row.id === 'number') await db.takes.update(row.id, { remainingFrames, percent });
  }
  const percent = Math.min(100, Math.round((confirmedTaken / planned) * 100));
  await db.shots.update(shotId, toPlain({ progressPercent: percent, updatedAt: Date.now() }));
  return percent;
}

/**
 * 帧序或曝光改动后：把该镜头已确认的实拍记录全部作废为待确认，
 * 并立刻重算进度（只累计仍确认的张数）。事务写入，失败整体回滚。
 * 返回重算后的完成百分比。
 */
export async function invalidateConfirmedTakes(shotId: number, reason: string): Promise<number> {
  return db.transaction('rw', db.takes, db.shots, async () => {
    const now = Date.now();
    await db.takes
      .where('shotId')
      .equals(shotId)
      .and((row) => row.confirmed)
      .modify({ confirmed: false, invalidReason: reason, invalidatedAt: now });
    return recalcShotTakesLocked(shotId);
  });
}

/** 持有人重新确认实拍记录（可一次确认多条），确认后重算进度。返回重算后的完成百分比 */
export async function confirmTakes(shotId: number, ids: number[], by: string): Promise<number> {
  return db.transaction('rw', db.takes, db.shots, async () => {
    const now = Date.now();
    for (const id of ids) {
      await db.takes.update(id, { confirmed: true, confirmedBy: by, confirmedAt: now, invalidReason: '', invalidatedAt: 0 });
    }
    return recalcShotTakesLocked(shotId);
  });
}

/** 登记一条实拍并立刻重算台账快照与镜头进度（同一事务） */
export async function addTakeAndRecalc(take: TakeLog): Promise<{ id: number; percent: number }> {
  return db.transaction('rw', db.takes, db.shots, async () => {
    const id = await db.takes.add(toPlain(take));
    const percent = await recalcShotTakesLocked(take.shotId);
    return { id, percent };
  });
}

/** 删除一条实拍并重算台账（保持台账与进度一致） */
export async function deleteTakeAndRecalc(id: number, shotId?: number): Promise<number> {
  return db.transaction('rw', db.takes, db.shots, async () => {
    await db.takes.delete(id);
    return typeof shotId === 'number' ? recalcShotTakesLocked(shotId) : 0;
  });
}

/* ---------------- permits（拍摄授权） ---------------- */

export async function listPermits(): Promise<Permit[]> {
  return db.permits.toArray();
}

export async function getPermitByShot(shotId: number): Promise<Permit | undefined> {
  return db.permits.where('shotId').equals(shotId).first();
}

export async function addPermit(permit: Permit): Promise<number> {
  return db.permits.add(toPlain(permit));
}

export async function updatePermit(id: number, patch: Partial<Permit>): Promise<void> {
  await db.permits.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}
