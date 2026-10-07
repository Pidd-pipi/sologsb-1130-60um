/** 镜头拍摄状态 */
export type ShotStatus = '未开机' | '拍摄中' | '已完成';

export const SHOT_STATUS_OPTIONS: ShotStatus[] = ['未开机', '拍摄中', '已完成'];

/** 可选帧率 */
export const FPS_OPTIONS = [8, 12, 15, 24, 25, 30] as const;

/** 镜头（一个可独立拍摄的定格动画分镜单元） */
export interface Shot {
  id?: number;
  /** 镜号，如 S01 */
  code: string;
  /** 场景名 */
  sceneName: string;
  /** 帧率 */
  fps: number;
  /** 预计时长（秒） */
  durationSec: number;
  /** 起始帧号 */
  startFrame: number;
  /** 结束帧号 */
  endFrame: number;
  /** 拍摄状态 */
  status: ShotStatus;
  /** 负责人 */
  owner: string;
  /** 完成百分比快照（由实拍记录回写，0-100） */
  progressPercent: number;
  /** 拍摄授权持有人：只有持有人可登记实拍张数、改动帧序与曝光 */
  authHolder: string;
  /** 授权交接次数（含初始认领，每次交接 +1） */
  authVersion: number;
  /** 授权最近一次交接时间戳 */
  authTransferredAt: number;
  /**
   * 帧序/曝光版本号：任何帧序或曝光改动都会 +1，
   * 已确认的实拍进度据此判定是否作废。
   */
  frameVersion: number;
  /** 实拍进度是否已由持有人确认 */
  progressConfirmed: boolean;
  /** 确认时的帧序/曝光版本号快照 */
  confirmedFrameVersion: number;
  /** 确认时的累计实拍张数快照 */
  confirmedTaken: number;
  /** 确认时的累计废帧数快照 */
  confirmedWasted: number;
  /** 最近一次确认时间戳 */
  confirmedAt: number;
  /** 最近一次确认人（授权持有人） */
  confirmedBy: string;
  /** 创建时间戳 */
  createdAt: number;
  updatedAt: number;
}

export const createEmptyShot = (): Shot => ({
  code: '',
  sceneName: '',
  fps: 24,
  durationSec: 2,
  startFrame: 1,
  endFrame: 48,
  status: '未开机',
  owner: '',
  progressPercent: 0,
  authHolder: '',
  authVersion: 0,
  authTransferredAt: 0,
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

/** 帧序/曝光字段：这些字段一动，已确认的实拍进度立刻作废 */
export const EXPOSURE_FIELDS = [
  'shotCount',
  'exposureSec',
  'aperture',
  'iso',
  'shutterAngle',
] as const;
export type ExposureField = (typeof EXPOSURE_FIELDS)[number];

export function isExposureField(key: string): key is ExposureField {
  return (EXPOSURE_FIELDS as readonly string[]).includes(key);
}

/** 已确认实拍进度的判定结果 */
export interface ProgressAttestation {
  /** 是否处于已确认状态 */
  confirmed: boolean;
  /** 是否已作废（曾确认过，但帧序/曝光或实拍张数发生变化，需重新确认） */
  stale: boolean;
}

/**
 * 判定一条镜头的实拍进度确认状态：
 * - 必须显式确认过；
 * - 确认时的帧序/曝光版本必须与当前一致；
 * - 确认后实拍张数/废帧数没有再被改动。
 */
export function attestProgress(
  shot: Pick<Shot, 'progressConfirmed' | 'confirmedFrameVersion' | 'frameVersion' | 'confirmedTaken' | 'confirmedWasted'>,
  taken: number,
  wasted: number,
): ProgressAttestation {
  const stale =
    shot.progressConfirmed &&
    (shot.confirmedFrameVersion !== shot.frameVersion ||
      shot.confirmedTaken !== taken ||
      shot.confirmedWasted !== wasted);
  return { confirmed: shot.progressConfirmed && !stale, stale };
}
