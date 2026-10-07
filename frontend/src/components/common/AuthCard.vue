<script setup lang="ts">
/**
 * 拍摄授权卡：展示某条镜头当前由谁接手、授权版本与交接时间，
 * 提供「交接到下一位」与「认领挂起授权」动作；
 * 同时展示实拍进度的确认/作废状态，并允许持有人重新确认。
 * 被 /shots/:id、/frames、/progress 消费。
 */
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useAuthStore } from '../../stores/authStore';
import { useShotStore } from '../../stores/shotStore';
import { formatDateTime } from '../../utils/format';
import type { Shot } from '../../types/shot';

interface Props {
  shot: Shot;
  /** 当前实拍累计张数（来自 takes 汇总） */
  taken?: number;
  /** 当前废帧累计 */
  wasted?: number;
  /** 紧凑模式（嵌入编排台/实拍记录页） */
  compact?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  taken: 0,
  wasted: 0,
  compact: false,
});

const emit = defineEmits<{
  (e: 'changed'): void;
}>();

const auth = useAuthStore();
const shotStore = useShotStore();
const { operator } = storeToRefs(auth);

const nextHolder = ref('');
const busy = ref(false);
const errorText = ref('');
const info = ref('');

const holder = computed(() => props.shot.authHolder?.trim() ?? '');
const held = computed(() => !!holder.value);
const iAmHolder = computed(() => !!operator.value && holder.value === operator.value);
const stale = computed(
  () =>
    props.shot.progressConfirmed &&
    (props.shot.confirmedFrameVersion !== props.shot.frameVersion ||
      props.shot.confirmedTaken !== props.taken ||
      props.shot.confirmedWasted !== props.wasted),
);
const confirmed = computed(() => props.shot.progressConfirmed && !stale.value);

function flash(text: string) {
  info.value = text;
  window.setTimeout(() => {
    if (info.value === text) info.value = '';
  }, 3200);
}

async function run(fn: () => Promise<unknown>, ok: string) {
  errorText.value = '';
  busy.value = true;
  try {
    await fn();
    flash(ok);
    emit('changed');
  } catch (e) {
    errorText.value = e instanceof Error ? e.message : '操作失败，请重试';
  } finally {
    busy.value = false;
  }
}

function doHandover() {
  const to = nextHolder.value.trim();
  void run(async () => {
    await shotStore.handover(props.shot.id as number, to);
    nextHolder.value = '';
  }, `拍摄授权已交给「${to}」，原持有人不再能改动帧序、曝光或登记实拍`);
}

function doClaim() {
  void run(async () => {
    await shotStore.claim(props.shot.id as number);
  }, `${operator.value} 已认领该镜头的拍摄授权`);
}

function doConfirm() {
  void run(async () => {
    await shotStore.confirmProgress(props.shot.id as number);
  }, '已按当前帧序/曝光与实拍张数重新确认进度');
}
</script>

<template>
  <div class="auth-card" :class="{ compact }" data-testid="auth-card">
    <div class="auth-head">
      <span class="auth-title">拍摄授权</span>
      <span v-if="held" class="holder-badge" data-testid="auth-holder">
        当前由 <strong>{{ holder }}</strong> 接手
      </span>
      <span v-else class="holder-badge open" data-testid="auth-holder">授权挂起 · 待认领</span>
    </div>

    <div class="auth-meta">
      <span class="muted">授权版本 v{{ shot.authVersion ?? 0 }}</span>
      <span v-if="shot.authTransferredAt" class="muted">最近交接 {{ formatDateTime(shot.authTransferredAt) }}</span>
      <span v-if="iAmHolder" class="tag me">我是持有人</span>
      <span v-else-if="held && operator" class="tag locked">我无此镜头权限</span>
      <span v-else-if="!held" class="tag idle">授权挂起</span>
    </div>

    <div class="attest" data-testid="auth-attest">
      <template v-if="confirmed">
        <span class="dot ok"></span>
        <span class="attest-text ok">实拍进度已确认</span>
        <span v-if="shot.confirmedAt" class="muted">
          {{ shot.confirmedBy || holder }} · {{ formatDateTime(shot.confirmedAt) }}
        </span>
      </template>
      <template v-else-if="stale">
        <span class="dot warn"></span>
        <span class="attest-text warn" data-testid="auth-stale">
          帧序/曝光或实拍张数有改动，已确认进度作废，待持有人重新确认
        </span>
      </template>
      <template v-else>
        <span class="dot idle"></span>
        <span class="attest-text muted">实拍进度尚未确认</span>
      </template>
    </div>

    <div v-if="!compact || held" class="auth-actions">
      <template v-if="held">
        <input
          v-model="nextHolder"
          type="text"
          maxlength="20"
          class="holder-input"
          data-testid="auth-handover-input"
          placeholder="交接给（输入接手人姓名）"
        />
        <button
          type="button"
          class="btn primary small"
          data-testid="auth-handover-btn"
          :disabled="busy || !iAmHolder"
          :title="iAmHolder ? '' : '只有当前持有人才能交接授权'"
          @click="doHandover"
        >
          交接授权
        </button>
        <button
          type="button"
          class="btn small"
          data-testid="auth-confirm-btn"
          :disabled="busy || !iAmHolder || confirmed"
          :title="iAmHolder ? '' : '只有当前持有人才能确认实拍进度'"
          @click="doConfirm"
        >
          {{ stale ? '重新确认进度' : '确认实拍进度' }}
        </button>
      </template>
      <template v-else>
        <button
          type="button"
          class="btn primary small"
          data-testid="auth-claim-btn"
          :disabled="busy || !operator"
          :title="operator ? '' : '请先在顶部设置当前操作员'"
          @click="doClaim"
        >
          我来接手（认领授权）
        </button>
      </template>
    </div>

    <p v-if="!held && !operator" class="muted tip">顶部先设置当前操作员姓名，才能认领授权。</p>
    <p v-if="errorText" class="err" data-testid="auth-error">{{ errorText }}</p>
    <p v-if="info" class="ok-text" data-testid="auth-info">{{ info }}</p>
  </div>
</template>

<style scoped>
.auth-card {
  border: 1px solid #d8dee9;
  border-radius: 10px;
  padding: 12px 14px;
  background: #fbfcfe;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.auth-card.compact {
  padding: 10px 12px;
  gap: 6px;
}
.auth-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.auth-title {
  font-size: 13px;
  font-weight: 700;
  color: #1f2d3d;
}
.holder-badge {
  font-size: 13px;
  color: #24559c;
  background: #eef4ff;
  border: 1px solid #d3e1ff;
  border-radius: 999px;
  padding: 2px 10px;
}
.holder-badge.open {
  color: #9a6a12;
  background: #fdf6e7;
  border-color: #f3e0b4;
}
.holder-badge strong {
  font-weight: 700;
}
.auth-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.tag {
  font-size: 11px;
  border-radius: 6px;
  padding: 1px 8px;
}
.tag.me {
  color: #1f7a52;
  background: #e6f6ee;
  border: 1px solid #bfe6d2;
}
.tag.locked {
  color: #9a5a12;
  background: #fdf2e4;
  border: 1px solid #f1dbb8;
}
.tag.idle {
  color: #6b7686;
  background: #f2f4f8;
  border: 1px solid #e2e7ef;
}
.attest {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.dot.ok {
  background: #3aa675;
}
.dot.warn {
  background: #d99b2b;
}
.dot.idle {
  background: #b9c2d0;
}
.attest-text.ok {
  color: #1f7a52;
  font-weight: 600;
}
.attest-text.warn {
  color: #9a6a12;
  font-weight: 600;
}
.auth-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.holder-input {
  height: 28px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  min-width: 200px;
}
.btn {
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 12px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.small {
  font-size: 12px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.err {
  color: #c45656;
  font-size: 12px;
  margin: 0;
}
.ok-text {
  color: #1f7a52;
  font-size: 12px;
  margin: 0;
}
.tip {
  margin: 0;
}
</style>
