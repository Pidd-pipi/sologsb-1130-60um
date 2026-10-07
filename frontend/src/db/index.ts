/**
 * IndexedDB 持久化层（Dexie 封装）。
 * 库名 gbstopmotion-db，含版本号与升级迁移：
 *   v1 建 shots / frames
 *   v2 增加 props 表与 shotId 索引
 *   v3 增加 takes 表，并按实拍张数回填进度
 *   v4 增加 permits 表（拍摄授权），按负责人回填授权、旧实拍标记为已确认；
 *      升级运行在版本变更事务里，任一步写入失败都会中止事务，
 *      授权与实拍的改动随版本一起回滚，旧数据恢复原样
 */
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import type { Permit } from '../types/permit';

export const DB_NAME = 'gbstopmotion-db';

/**
 * 脱代理：Pinia 里的对象是 Proxy，直接写进 IndexedDB 会抛 DataCloneError。
 * 这里统一做一次结构化克隆后的纯对象转换。
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

export class StopMotionDb extends Dexie {
  shots!: Table<Shot, number>;
  frames!: Table<FrameEntry, number>;
  props!: Table<PropState, number>;
  takes!: Table<TakeLog, number>;
  permits!: Table<Permit, number>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      shots: '++id, code, status, sceneName',
      frames: '++id, shotId, frameNo, [shotId+frameNo]',
    });
    this.version(2)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
      })
      .upgrade(async (tx) => {
        // v2：为已有帧补齐道具位移字段，保证轨迹页可直接读取
        await tx
          .table('frames')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.propOffsetMm !== 'number') row.propOffsetMm = 0;
          });
      });
    this.version(3)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
      })
      .upgrade(async (tx) => {
        // v3：按已登记的实拍张数回填完成百分比
        const takes = await tx.table('takes').toCollection().toArray();
        const shots = await tx.table('shots').toCollection().toArray();
        for (const take of takes) {
          const shot = shots.find((s: Record<string, unknown>) => s.id === take.shotId);
          if (!shot || typeof shot.durationSec !== 'number' || typeof shot.fps !== 'number') continue;
          const total = Math.max(1, Math.ceil(shot.durationSec * shot.fps));
          const percent = Math.min(100, Math.round((take.takenFrames / total) * 100));
          await tx.table('takes').update(take.id, { percent });
        }
      });
    this.version(4)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
        permits: '++id, shotId, holder',
      })
      .upgrade(async (tx) => {
        // v4：旧数据按负责人回填拍摄授权，旧实拍记录视为已确认（确认人记为负责人）。
        // 整个升级跑在 Dexie 版本变更事务里：任何一步写入失败都会中止事务，
        // permits 与 takes 的全部改动随版本回滚，授权和实拍都恢复原样。
        try {
          const shots = await tx.table('shots').toArray();
          const now = Date.now();
          const ownerByShot = new Map<number, string>();
          for (const shot of shots) {
            const owner = typeof shot.owner === 'string' ? shot.owner : '';
            ownerByShot.set(shot.id, owner);
            await tx.table('permits').add({
              shotId: shot.id,
              shotCode: typeof shot.code === 'string' ? shot.code : '',
              holder: owner,
              revision: 1,
              history: [],
              updatedAt: now,
            });
          }
          await tx
            .table('takes')
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.confirmed === 'boolean') return;
              row.confirmed = true;
              row.confirmedBy = ownerByShot.get(row.shotId as number) ?? '';
              row.confirmedAt = typeof row.updatedAt === 'number' ? row.updatedAt : now;
              row.invalidReason = '';
              row.invalidatedAt = 0;
            });
        } catch (e) {
          // 重新抛出，让 Dexie 中止升级事务：授权与实拍保持升级前的样子
          console.error('[gbstopmotion] v4 授权回填失败，事务回滚，授权与实拍恢复原样', e);
          throw e;
        }
      });
  }
}

export const db = new StopMotionDb();
