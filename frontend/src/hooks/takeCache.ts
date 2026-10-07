/**
 * 实拍记录共享缓存：useProgress 与各 store 的作废/确认联动读写同一份响应式数据。
 * 帧序或曝光改动在 store 层作废实拍后，也会刷新这里，
 * 保证总览、详情、实拍记录页的进度与台账即时一致。
 */
import { ref } from 'vue';
import * as api from '../db/api';
import type { TakeLog } from '../types/take';

export const takesCache = ref<TakeLog[]>([]);
export const takesLoading = ref(false);

/** 重新拉取全部实拍记录 */
export async function refreshTakesCache(): Promise<void> {
  takesLoading.value = true;
  try {
    takesCache.value = await api.listTakes();
  } finally {
    takesLoading.value = false;
  }
}
