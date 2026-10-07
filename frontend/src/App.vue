<script setup lang="ts">
/** 应用外壳：顶部导航 + 当前操作人（拍摄授权的操作身份）+ 路由出口 */
import { computed, onMounted } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import { navItems } from './router';
import { useUiStore } from './stores/uiStore';
import { usePermitStore } from './stores/permitStore';

const route = useRoute();
const ui = useUiStore();
const permitStore = usePermitStore();

/** 当前操作人：与拍摄授权的持有人比对，决定能否登记实拍、改动帧序或曝光 */
const operator = computed({
  get: () => permitStore.operator,
  set: (name: string) => permitStore.setOperator(name),
});

onMounted(() => {
  void permitStore.load();
});

function isActive(path: string): boolean {
  if (path === '/') return route.path === '/';
  return route.path === path || route.path.startsWith(`${path}/`);
}
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="logo">帧</span>
        <div class="brand-text">
          <strong>定格动画拍摄帧序编排台</strong>
          <small>镜头拆分 · 帧序编排 · 曝光与道具位移记录</small>
        </div>
      </div>
      <nav class="nav">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" :class="{ active: isActive(item.path) }">
          {{ item.label }}
        </RouterLink>
      </nav>
      <label class="operator-box" title="拍摄授权按操作人校验：只有持有人能登记实拍、改动帧序或曝光">
        <span>当前操作人</span>
        <input v-model="operator" type="text" maxlength="20" placeholder="未设置" data-testid="operator-input" />
      </label>
    </header>

    <main class="content">
      <RouterView />
    </main>

    <footer class="footbar">
      <span>数据保存在浏览器本地（IndexedDB：gbstopmotion-db），表单草稿保存在 localStorage</span>
      <span v-if="ui.lastError" class="err">最近错误：{{ ui.lastError }}</span>
    </footer>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f4f6fa;
  color: #1f2d3d;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 28px;
  padding: 12px 24px;
  background: #fff;
  border-bottom: 1px solid #e2e7ef;
  position: sticky;
  top: 0;
  z-index: 10;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: linear-gradient(135deg, #2f6fed, #7aa7ff);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}
.brand-text strong {
  font-size: 15px;
}
.brand-text small {
  color: #8a94a6;
  font-size: 11px;
}
.nav {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.nav a {
  text-decoration: none;
  color: #4a5464;
  font-size: 13px;
  padding: 6px 12px;
  border-radius: 7px;
}
.nav a:hover {
  background: #f0f4ff;
  color: #2f6fed;
}
.nav a.active {
  background: #2f6fed;
  color: #fff;
}
.operator-box {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #5a6472;
  white-space: nowrap;
}
.operator-box input {
  height: 30px;
  width: 120px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
}
.content {
  flex: 1;
  padding: 20px 24px 32px;
  max-width: 1480px;
  width: 100%;
  box-sizing: border-box;
  margin: 0 auto;
}
.footbar {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 24px;
  background: #fff;
  border-top: 1px solid #e2e7ef;
  color: #8a94a6;
  font-size: 12px;
}
.footbar .err {
  color: #c45656;
}
</style>
