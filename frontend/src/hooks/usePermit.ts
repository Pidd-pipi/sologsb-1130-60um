/**
 * 拍摄授权的页面侧守卫：把授权校验包成页面可直接用的工具。
 * guarded 执行需要授权的操作：权限拒绝时返回提示文案（页面 flash 展示），
 * 其它异常继续抛出，不吞系统错误。
 */
import { usePermitStore, PermitDeniedError } from '../stores/permitStore';

export function usePermit() {
  const permitStore = usePermitStore();

  /**
   * 执行需要授权的操作。
   * 返回空串表示已执行；返回文案表示被权限拒绝。
   */
  async function guarded(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
      return '';
    } catch (e) {
      if (e instanceof PermitDeniedError) return e.message || '权限拒绝';
      throw e;
    }
  }

  return { permitStore, guarded };
}
