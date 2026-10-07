/**
 * 拍摄授权（换班）规则。
 * 每条镜头持有一份「拍摄授权」：只有当前持有人可以
 *   1. 登记实拍张数；
 *   2. 改动帧序或曝光。
 * 授权交出后原持有人立即失去上述权限。
 *
 * 当前操作员（当前坐班的人）保存在 localStorage，
 * 命名空间统一前缀 gbstopmotion:draft: 之外，用独立 operator 键。
 */
import type { Shot } from '../types/shot';

const OPERATOR_KEY = 'gbstopmotion:operator';

/** 读取当前操作员姓名 */
export function getOperator(): string {
  try {
    return (localStorage.getItem(OPERATOR_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

/** 设置当前操作员姓名 */
export function setOperator(name: string): void {
  const value = name.trim();
  try {
    if (value) localStorage.setItem(OPERATOR_KEY, value);
    else localStorage.removeItem(OPERATOR_KEY);
  } catch {
    /* 存储不可用时静默跳过 */
  }
}

/** 某人是否为该镜头当前的拍摄授权持有人 */
export function isHolder(shot: Pick<Shot, 'authHolder'> | undefined, operator: string): boolean {
  return !!operator && !!shot && shot.authHolder.trim() === operator.trim();
}

/** 权限拒绝错误：非持有人触碰仅持有人可用的动作时抛出，由页面提示 */
export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * 断言当前操作员是镜头持有人，否则抛 PermissionDeniedError。
 * @param action 动作描述，用于拼错误文案，如「登记实拍」「改动帧序或曝光」
 */
export function assertHolder(
  shot: Pick<Shot, 'authHolder'> | undefined,
  operator: string,
  action = '该操作',
): void {
  const holder = shot?.authHolder.trim() ?? '';
  if (!holder) {
    throw new PermissionDeniedError(`权限拒绝：该镜头还没有拍摄授权持有人，需先认领或交接授权后才能${action}`);
  }
  if (!operator) {
    throw new PermissionDeniedError(`权限拒绝：请先在顶部设置当前操作员，再${action}`);
  }
  if (!isHolder(shot, operator)) {
    throw new PermissionDeniedError(`权限拒绝：当前由「${holder}」接手，只有持有人才能${action}`);
  }
}

/** 判断错误是否为权限拒绝 */
export function isPermissionDenied(e: unknown): e is PermissionDeniedError {
  return e instanceof PermissionDeniedError;
}

/**
 * 数据层兜底鉴权：以 localStorage 里的当前操作员为准，
 * 保证任何绕过 store 的写入也无法越过持有人授权。
 */
export function assertCurrentHolder(
  shot: Pick<Shot, 'authHolder'> | undefined,
  action = '该操作',
): void {
  assertHolder(shot, getOperator(), action);
}
