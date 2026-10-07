/** 一条实拍登记记录（按镜头 + 日期汇总当日张数） */
export interface TakeLog {
  id?: number;
  /** 拍摄日期 YYYY-MM-DD */
  date: string;
  /** 镜号，便于按镜头阅读 */
  shotCode: string;
  /** 关联镜头 id */
  shotId: number;
  /** 实拍张数 */
  takenFrames: number;
  /** 废帧数 */
  wastedFrames: number;
  /** 剩余张数（登记时快照） */
  remainingFrames: number;
  /** 完成百分比 0-100 */
  percent: number;
  /** 是否已确认：帧序或曝光改动后会被作废为待确认，需持有人重新确认 */
  confirmed: boolean;
  /** 确认人（登记即确认的填登记时的持有人） */
  confirmedBy: string;
  /** 确认时间戳，未确认为 0 */
  confirmedAt: number;
  /** 作废原因（帧序改动 / 曝光改动），未作废为空串 */
  invalidReason: string;
  /** 作废时间戳，未作废为 0 */
  invalidatedAt: number;
  updatedAt: number;
}

export const createEmptyTake = (shotId: number, shotCode: string): TakeLog => ({
  date: new Date().toISOString().slice(0, 10),
  shotCode,
  shotId,
  takenFrames: 0,
  wastedFrames: 0,
  remainingFrames: 0,
  percent: 0,
  confirmed: true,
  confirmedBy: '',
  confirmedAt: 0,
  invalidReason: '',
  invalidatedAt: 0,
  updatedAt: Date.now(),
});

/** 废帧分布的一个分组 */
export interface WasteBucket {
  label: string;
  count: number;
}
