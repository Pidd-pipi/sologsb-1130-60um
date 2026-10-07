/**
 * 拍摄授权运行时集成测试（不走 UI，直打数据层）。
 * 运行：npx esbuild test/auth.test.ts --bundle --platform=node --format=cjs --outfile=test/auth.test.cjs && node test/auth.test.cjs
 */
import 'fake-indexeddb/auto';

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
(globalThis as unknown as Record<string, unknown>).localStorage = new MemoryStorage();

import { db } from '../src/db/index';
import * as api from '../src/db/api';
import Dexie from 'dexie';
import { setOperator, PermissionDeniedError } from '../src/utils/permission';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name} ${extra}`);
  }
}
async function expectThrow(name: string, fn: () => Promise<unknown>, Ctor: Function = Error) {
  try {
    await fn();
    check(name, false, '（未抛错）');
  } catch (e) {
    check(name, e instanceof Ctor, `（得到 ${(e as Error)?.name}: ${(e as Error)?.message}）`);
  }
}

async function resetDb(version = 4) {
  await db.close();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('gbstopmotion-db');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
  await db.open(version as never);
}

/* 造一条两帧的镜头（直接写 v4 形态） */
async function seedShot(owner: string) {
  const id = await api.addShot({
    code: 'S01',
    sceneName: '测试',
    fps: 24,
    durationSec: Math.round((2 / 24) * 1000) / 1000,
    startFrame: 1,
    endFrame: 2,
    status: '未开机',
    owner,
    progressPercent: 0,
    authHolder: owner,
    authVersion: 1,
    authTransferredAt: Date.now(),
    frameVersion: 0,
    progressConfirmed: false,
    confirmedFrameVersion: 0,
    confirmedTaken: 0,
    confirmedWasted: 0,
    confirmedAt: 0,
    confirmedBy: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await api.addFrames([
    { frameNo: 1, shotId: id, shotCount: 2, exposureSec: 0.25, aperture: 5.6, iso: 200, shutterAngle: 180, lighting: '灯', propOffsetMm: 0, note: '', updatedAt: Date.now() },
    { frameNo: 2, shotId: id, shotCount: 2, exposureSec: 0.25, aperture: 5.6, iso: 200, shutterAngle: 180, lighting: '灯', propOffsetMm: 0, note: '', updatedAt: Date.now() },
  ]);
  return id;
}

async function main() {
  /* 1. 非持有人被权限拒绝，且没有任何写入 */
  await resetDb();
  setOperator('阿明');
  const sid = await seedShot('阿明');
  setOperator('小红');

  await expectThrow(
    '非持有人登记实拍 → 权限拒绝',
    () =>
      api.registerTakeAtomic({
        date: '2026-10-07',
        shotCode: 'S01',
        shotId: sid,
        takenFrames: 5,
        wastedFrames: 0,
        remainingFrames: 0,
        percent: 0,
        registeredBy: '小红',
        updatedAt: Date.now(),
      }),
  );
  const takesAfterDeny = await api.listTakesByShot(sid);
  check('被拒后没有留下实拍记录', takesAfterDeny.length === 0);
  const shotAfterDeny = (await api.getShot(sid))!;
  check('被拒后授权持有人不变', shotAfterDeny.authHolder === '阿明');

  /* 2. 持有人登记实拍成功，原子回写进度并作废确认 */
  setOperator('阿明');
  await api.registerTakeAtomic({
    date: '2026-10-07',
    shotCode: 'S01',
    shotId: sid,
    takenFrames: 2,
    wastedFrames: 0,
    remainingFrames: 0,
    percent: 100,
    registeredBy: '阿明',
    updatedAt: Date.now(),
  });
  let shot2 = (await api.getShot(sid))!;
  check('登记后百分比回写为 100', shot2.progressPercent === 100, `got ${shot2.progressPercent}`);
  check('登记后确认状态作废', shot2.progressConfirmed === false);

  /* 3. 持有人确认进度 */
  shot2 = await api.confirmShotProgress(sid, '阿明');
  check('确认后 progressConfirmed=true', shot2.progressConfirmed === true);
  check('确认快照记录张数=2', shot2.confirmedTaken === 2 && shot2.confirmedFrameVersion === 0);

  /* 4. 曝光改动使确认作废、frameVersion +1、百分比重算 */
  const frames = await api.listFrames(sid);
  frames[0].exposureSec = 0.5;
  await api.commitShotFrames({ shotId: sid, frames, invalidate: true });
  const shot3 = (await api.getShot(sid))!;
  check('曝光改动后 frameVersion +1', shot3.frameVersion === 1);
  check('曝光改动后确认作废', shot3.progressConfirmed === false);
  const framesBack = await api.listFrames(sid);
  check('曝光改动已落库', framesBack[0].exposureSec === 0.5);
  check('帧序号仍连续 1..2', framesBack.map((f) => f.frameNo).join() === '1,2');

  /* 5. 插入帧（帧序改动）作废重算，帧数/区间/时长联动 */
  const before = await api.listFrames(sid);
  before.splice(1, 0, {
    frameNo: 2,
    shotId: sid,
    shotCount: 2,
    exposureSec: 0.25,
    aperture: 5.6,
    iso: 200,
    shutterAngle: 180,
    lighting: '灯',
    propOffsetMm: 0,
    note: '',
    updatedAt: Date.now(),
  });
  const saved = await api.commitShotFrames({ shotId: sid, frames: before, invalidate: true });
  check('插帧后 endFrame=3', saved.endFrame === 3, `got ${saved.endFrame}`);
  check('插帧后时长=3/24', saved.durationSec === Math.round((3 / 24) * 1000) / 1000, `got ${saved.durationSec}`);
  check('插帧后 frameVersion=2', saved.frameVersion === 2);
  check('插帧后实拍 2/3 百分比重算', saved.progressPercent === 67, `got ${saved.progressPercent}`);

  /* 6. 交接授权：新持有人可操作，原持有人被拒 */
  await api.handoverShot(sid, '小红');
  const shot4 = (await api.getShot(sid))!;
  check('交接后持有人=小红', shot4.authHolder === '小红' && shot4.authVersion === 2);
  setOperator('阿明');
  const f6 = await api.listFrames(sid);
  f6[0].iso = 400;
  await expectThrow(
    '交出后原持有人改曝光 → 权限拒绝',
    async () => {
      // 模拟 store 层的持有人断言
      const { assertHolder } = await import('../src/utils/permission');
      assertHolder(shot4, '阿明', '改动曝光');
    },
    PermissionDeniedError,
  );
  setOperator('小红');
  // 小红改曝光成功
  const f7 = await api.listFrames(sid);
  f7[0].iso = 400;
  await api.commitShotFrames({ shotId: sid, frames: f7, invalidate: true });
  check('新持有人改曝光成功', (await api.listFrames(sid))[0].iso === 400);

  /* 7. 交接不改变确认快照版本（交接本身不作废进度），但之前已被帧改动作废 */
  const shot5 = (await api.getShot(sid))!;
  check('交接本身不回退 frameVersion', shot5.frameVersion === 3);

  /* 8. 删除实拍原子回滚 */
  const anyTake = (await api.listTakesByShot(sid))[0];
  await api.deleteTakeAtomic(anyTake.id as number);
  const shot6 = (await api.getShot(sid))!;
  check('删实拍后百分比归零', shot6.progressPercent === 0);
  check('删实拍后确认作废', shot6.progressConfirmed === false);

  /* 9. 模拟提交失败 → 事务回滚（用无效 shotId） */
  await expectThrow(
    '对不存在的镜头提交帧 → 失败',
    () =>
      api.commitShotFrames({
        shotId: 99999,
        frames: [],
        invalidate: true,
      }),
  );

  /* 10. v3→v4 升级：旧数据按负责人回填授权、既有实拍视为已确认 */
  db.close();
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('gbstopmotion-db');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  // 用一个只有 v1-v3 schema 的临时 Dexie 造旧库
  {
    const legacy = new Dexie('gbstopmotion-db');
    legacy.version(3).stores({
      shots: '++id, code, status, sceneName',
      frames: '++id, shotId, frameNo, [shotId+frameNo]',
      props: '++id, shotId, name, [shotId+fromFrame]',
      takes: '++id, shotId, date, shotCode',
    });
    await legacy.open();
    const shotId = await legacy.table('shots').add({
      code: 'S09',
      sceneName: '旧',
      fps: 12,
      durationSec: 2,
      startFrame: 1,
      endFrame: 24,
      status: '拍摄中',
      owner: '老周',
      progressPercent: 50,
      createdAt: 1,
      updatedAt: 1,
    });
    await legacy.table('takes').add({
      date: '2026-09-01',
      shotCode: 'S09',
      shotId,
      takenFrames: 12,
      wastedFrames: 1,
      remainingFrames: 12,
      percent: 50,
      updatedAt: 1,
    });
    legacy.close();
  }
  await db.open();
  const oldShots = await api.listShots();
  const oldShot = oldShots.find((s) => s.code === 'S09')!;
  check('升级后授权按负责人回填=老周', oldShot.authHolder === '老周', `got ${oldShot.authHolder}`);
  check('升级后 authVersion=1', oldShot.authVersion === 1);
  check('升级后既有实拍被一次性确认', oldShot.progressConfirmed === true && oldShot.confirmedTaken === 12);
  check('升级后确认人=老周', oldShot.confirmedBy === '老周');
  check('升级后 frameVersion 从 0 起', oldShot.frameVersion === 0);
  const oldTakes = await api.listTakesByShot(oldShot.id as number);
  check('升级后旧实拍登记人回填=老周', oldTakes[0].registeredBy === '老周');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
