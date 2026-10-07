/** 一次授权交接记录（从谁交给谁） */
export interface HandoverRecord {
  /** 交出方（空串表示从「待认领」状态被认领） */
  from: string;
  /** 接手方 */
  to: string;
  /** 交接时间戳 */
  at: number;
}

/**
 * 拍摄授权：每条镜头一份。
 * 只有当前持有人能登记实拍张数、改动帧序或曝光；
 * 交接之后原持有人再操作会被权限拒绝。
 */
export interface Permit {
  id?: number;
  /** 关联镜头 id（每镜头唯一一份） */
  shotId: number;
  /** 镜号快照，便于按镜头阅读 */
  shotCode: string;
  /** 当前持有人；空串表示待认领 */
  holder: string;
  /** 交接序号，首次发放为 1，每交接/认领一次 +1 */
  revision: number;
  /** 交接轨迹（最多保留最近 20 条） */
  history: HandoverRecord[];
  updatedAt: number;
}

/** 为镜头签发一份新授权（持有人缺省为负责人，其次为当前操作人） */
export const createPermitForShot = (shotId: number, shotCode: string, holder: string): Permit => ({
  shotId,
  shotCode,
  holder,
  revision: 1,
  history: [],
  updatedAt: Date.now(),
});
