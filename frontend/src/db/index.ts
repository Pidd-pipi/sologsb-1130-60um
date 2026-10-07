/**
 * IndexedDB 持久化层（Dexie 封装）。
 * 库名 gbstopmotion-db，含版本号与升级迁移：
 *   v1 建 shots / frames
 *   v2 增加 props 表与 shotId 索引
 *   v3 增加 takes 表，并按实拍张数回填进度
 *   v4 增加拍摄授权与实拍进度确认字段，旧数据按负责人回填授权
 */
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import { durationToFrames } from '../utils/frameMath';

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
        shots: '++id, code, status, sceneName, authHolder',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
      })
      .upgrade(async (tx) => {
        /**
         * v4：为每条镜头补发「拍摄授权」，旧数据按负责人回填：
         * - 授权持有人 = 原负责人（owner），负责人为空则授权挂起（待认领）；
         * - 既有实拍记录视为原负责人登记，并一次性承认为已确认进度
         *   （升级时刻帧序/曝光版本从 0 起，之后任何改动照常作废旧确认）；
         * - 整个回填在升级事务内完成，任一条写入失败整体回滚，
         *   授权与实拍数据都恢复成升级前原样。
         */
        const now = Date.now();
        const shotsTable = tx.table('shots');
        const takesTable = tx.table('takes');
        const shots = await shotsTable.toCollection().toArray();
        for (const raw of shots) {
          const row = raw as Record<string, unknown>;
          if (typeof row.id !== 'number') continue;
          const owner = typeof row.owner === 'string' ? row.owner.trim() : '';
          const fps = typeof row.fps === 'number' ? row.fps : 24;
          const durationSec = typeof row.durationSec === 'number' ? row.durationSec : 0;
          const shotTakes = (await takesTable.where('shotId').equals(row.id).toArray()) as Array<
            Record<string, unknown>
          >;
          const taken = shotTakes.reduce((sum, t) => sum + (typeof t.takenFrames === 'number' ? t.takenFrames : 0), 0);
          const wasted = shotTakes.reduce(
            (sum, t) => sum + (typeof t.wastedFrames === 'number' ? t.wastedFrames : 0),
            0,
          );
          const hasTakes = shotTakes.length > 0;
          const planned = durationToFrames(durationSec, fps);
          const percent = Math.min(100, Math.round((taken / planned) * 100));
          const patch: Record<string, unknown> = {
            authHolder: owner,
            authVersion: owner ? 1 : 0,
            authTransferredAt: owner ? now : 0,
            frameVersion: 0,
            progressConfirmed: hasTakes,
            confirmedFrameVersion: 0,
            confirmedTaken: hasTakes ? taken : 0,
            confirmedWasted: hasTakes ? wasted : 0,
            confirmedAt: hasTakes ? now : 0,
            confirmedBy: hasTakes ? owner : '',
            progressPercent: hasTakes ? percent : (typeof row.progressPercent === 'number' ? row.progressPercent : 0),
            updatedAt: now,
          };
          await shotsTable.update(row.id, patch);
          // 既有实拍记录补登记人 = 授权持有人（原负责人）
          for (const take of shotTakes) {
            if (typeof take.id === 'number' && typeof take.registeredBy !== 'string') {
              await takesTable.update(take.id, { registeredBy: owner });
            }
          }
        }
      });
  }
}

export const db = new StopMotionDb();
