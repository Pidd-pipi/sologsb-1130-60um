/**
 * 拍摄授权 store：每条镜头一份授权，记录当前持有人与交接轨迹。
 * - 持有人才能登记实拍张数、改动帧序或曝光；
 * - 交接之后原持有人再操作会被权限拒绝（PermitDeniedError）；
 * - 当前操作人保存在 localStorage（gbstopmotion:operator），换班时在页头切换。
 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import type { Permit, HandoverRecord } from '../types/permit';
import { createPermitForShot } from '../types/permit';
import type { Shot } from '../types/shot';

const OPERATOR_KEY = 'gbstopmotion:operator';

/** 权限拒绝：页面捕获后展示提示，不当作系统错误 */
export class PermitDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermitDeniedError';
  }
}

function readOperator(): string {
  try {
    return localStorage.getItem(OPERATOR_KEY) ?? '';
  } catch {
    return '';
  }
}

interface PermitState {
  permits: Permit[];
  /** 当前操作人（换班时在页头切换） */
  operator: string;
  ready: boolean;
}

export const usePermitStore = defineStore('permit', {
  state: (): PermitState => ({
    permits: [],
    operator: readOperator(),
    ready: false,
  }),
  getters: {
    permitOf(state) {
      return (shotId: number) => state.permits.find((p) => p.shotId === shotId);
    },
    /** 当前持有人姓名（空串 = 待认领） */
    holderOf(state): (shotId: number) => string {
      return (shotId: number) => state.permits.find((p) => p.shotId === shotId)?.holder ?? '';
    },
    /** 当前操作人是否为该镜头持有人 */
    isHolder(state): (shotId: number) => boolean {
      return (shotId: number) => {
        const holder = state.permits.find((p) => p.shotId === shotId)?.holder ?? '';
        return holder !== '' && holder === state.operator;
      };
    },
  },
  actions: {
    async load() {
      this.permits = await api.listPermits();
      this.ready = true;
    },
    setOperator(name: string) {
      this.operator = name.trim();
      try {
        localStorage.setItem(OPERATOR_KEY, this.operator);
      } catch {
        /* 存储不可用时仅保留内存态 */
      }
    },
    /**
     * 确保镜头已有授权：没有就按「负责人 → 当前操作人」签发。
     * 新建镜头后调用；也兜底 v4 迁移前遗漏的旧镜头。
     */
    async ensureForShot(shot: Shot) {
      if (typeof shot.id !== 'number') return;
      if (!this.ready) await this.load();
      if (this.permitOf(shot.id)) return;
      const existing = await api.getPermitByShot(shot.id);
      if (existing) {
        this.permits = [...this.permits, existing];
        return;
      }
      const permit = createPermitForShot(shot.id, shot.code, shot.owner.trim() || this.operator);
      const id = await api.addPermit(permit);
      this.permits = [...this.permits, { ...permit, id }];
    },
    /** 权限闸门：操作前校验当前操作人就是持有人，否则抛 PermitDeniedError */
    async assertHolder(shotId: number, action: string) {
      if (!this.ready) await this.load();
      let permit = this.permitOf(shotId);
      if (!permit) {
        // 授权缺失时按镜头负责人现场补发（与 v4 迁移同一规则），再校验
        const shot = await api.getShot(shotId);
        if (shot) {
          await this.ensureForShot(shot);
          permit = this.permitOf(shotId);
        }
      }
      if (!permit) throw new PermitDeniedError(`权限拒绝：该镜头还没有拍摄授权，无法${action}`);
      if (!permit.holder) throw new PermitDeniedError(`权限拒绝：授权待认领，请先到镜头详情认领后再${action}`);
      if (permit.holder !== this.operator) {
        const who = this.operator || '未设置';
        throw new PermitDeniedError(`权限拒绝：「${action}」只能由持有人 ${permit.holder} 操作（当前操作人：${who}）`);
      }
    },
    /** 持有人把授权交给接任人；交接后原持有人再动帧序或曝光会被权限拒绝 */
    async handover(shotId: number, to: string) {
      const target = to.trim();
      if (!target) throw new PermitDeniedError('请填写接任人姓名');
      await this.assertHolder(shotId, '交接授权');
      const permit = this.permitOf(shotId);
      if (!permit || typeof permit.id !== 'number') throw new PermitDeniedError('权限拒绝：该镜头还没有拍摄授权');
      if (permit.holder === target) throw new PermitDeniedError('接任人就是当前持有人，无需交接');
      const record: HandoverRecord = { from: permit.holder, to: target, at: Date.now() };
      const patch = {
        holder: target,
        revision: permit.revision + 1,
        history: [...permit.history, record].slice(-20),
      };
      await api.updatePermit(permit.id, patch);
      this.permits = this.permits.map((p) => (p.id === permit.id ? { ...p, ...patch, updatedAt: Date.now() } : p));
    },
    /** 授权待认领时，当前操作人认领为持有人 */
    async claim(shotId: number) {
      if (!this.operator) throw new PermitDeniedError('请先在页头设置当前操作人，再认领授权');
      if (!this.ready) await this.load();
      const permit = this.permitOf(shotId);
      if (!permit || typeof permit.id !== 'number') throw new PermitDeniedError('权限拒绝：该镜头还没有拍摄授权');
      if (permit.holder) throw new PermitDeniedError(`授权已由 ${permit.holder} 持有，需由其交接`);
      const record: HandoverRecord = { from: '', to: this.operator, at: Date.now() };
      const patch = {
        holder: this.operator,
        revision: permit.revision + 1,
        history: [...permit.history, record].slice(-20),
      };
      await api.updatePermit(permit.id, patch);
      this.permits = this.permits.map((p) => (p.id === permit.id ? { ...p, ...patch, updatedAt: Date.now() } : p));
    },
    /** 镜头删除后清理内存态（库内级联删除在 api.deleteShot） */
    dropForShot(shotId: number) {
      this.permits = this.permits.filter((p) => p.shotId !== shotId);
    },
  },
});
