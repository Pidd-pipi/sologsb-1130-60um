/**
 * 当前操作员 store：表示此刻坐在机位前的人（换班时切换）。
 * 持久化在 localStorage（gbstopmotion:operator），
 * 与镜头上的「拍摄授权持有人」比对后决定权限。
 */
import { defineStore } from 'pinia';
import { getOperator, setOperator } from '../utils/permission';
import type { Shot } from '../types/shot';
import { isHolder as checkHolder } from '../utils/permission';

interface AuthState {
  /** 当前操作员姓名 */
  operator: string;
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    operator: getOperator(),
  }),
  getters: {
    /** 是否已登记当前操作员 */
    signedIn(state): boolean {
      return !!state.operator;
    },
    /** 返回判断「某人是否为该镜头持有人」的函数 */
    holds() {
      return (shot: Pick<Shot, 'authHolder'> | undefined) => checkHolder(shot, this.operator);
    },
  },
  actions: {
    /** 切换当前操作员（换班登录） */
    signIn(name: string) {
      this.operator = name.trim();
      setOperator(this.operator);
    },
    /** 清除当前操作员 */
    signOut() {
      this.operator = '';
      setOperator('');
    },
  },
});
