/**
 * 拍摄授权端到端冒烟测试（真实 DOM + IndexedDB）：
 * 运行：node test/e2e.auth.mjs
 * 前置：npm run dev -- --port 5199 已启动
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5199';
const results = [];
function ok(name, cond, extra = '') {
  results.push([cond, name, extra]);
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(BASE + '/shots/new', { waitUntil: 'networkidle' });

// 1. 用「阿明」身份新建镜头
await page.fill('[data-testid="operator-input"]', '阿明');
await page.press('[data-testid="operator-input"]', 'Enter');
await page.fill('#shot-code', 'T01');
await page.fill('#shot-scene', '授权测试');
await page.fill('#shot-owner', '阿明');
await page.click('[data-testid="submit-shot"]');
await page.waitForURL(/\/shots\/\d+/, { timeout: 10000 });
await page.waitForSelector('[data-testid="auth-card"]');
ok('详情页显示授权持有人=阿明', (await page.textContent('[data-testid="auth-holder"]'))?.includes('阿明'));

// 2. 非持有人不能登记实拍
await page.fill('[data-testid="operator-input"]', '小红');
await page.press('[data-testid="operator-input"]', 'Enter');
const takeDisabled = await page.isDisabled('[data-testid="take-submit"]');
ok('切到小红后登记实拍按钮被禁用', takeDisabled);
ok('非持有人看到锁定横幅', (await page.textContent('[data-testid="detail-lock"]'))?.includes('小红'));

// 3. 非持有人无法通过接口写（直接触发被禁用按钮不会执行；改为切回阿明登记）
await page.fill('[data-testid="operator-input"]', '阿明');
await page.press('[data-testid="operator-input"]', 'Enter');
await page.fill('[data-testid="take-taken"]', '10');
await page.click('[data-testid="take-submit"]');
await page.waitForTimeout(600);
ok('持有人登记后出现作废/待确认提示', (await page.textContent('[data-testid="auth-attest"]'))?.includes('尚未确认') || (await page.textContent('[data-testid="auth-attest"]'))?.includes('作废'));

// 4. 持有人确认进度
await page.click('[data-testid="auth-confirm-btn"]');
await page.waitForTimeout(600);
ok('确认后显示已确认', (await page.textContent('[data-testid="auth-attest"]'))?.includes('已确认'));

// 5. 帧序改动使确认作废（插入帧）
await page.click('[data-testid="insert-frame"]');
await page.waitForTimeout(700);
const attestAfterInsert = await page.textContent('[data-testid="auth-attest"]');
ok('插帧后确认作废待重认', attestAfterInsert?.includes('作废'), attestAfterInsert);

// 6. 曝光改动也作废（编辑第一帧曝光）——先重新确认
await page.click('[data-testid="auth-confirm-btn"]');
await page.waitForTimeout(500);
await page.fill('table[data-testid="frame-table"] tbody tr:first-child td:nth-child(4) input', '0.5');
await page.press('table[data-testid="frame-table"] tbody tr:first-child td:nth-child(4) input', 'Blur');
await page.waitForTimeout(700);
const attestAfterExp = await page.textContent('[data-testid="auth-attest"]');
ok('曝光改动后确认作废', attestAfterExp?.includes('作废'), attestAfterExp);

// 7. 小红登录后无法改曝光：字段应禁用
await page.fill('[data-testid="operator-input"]', '小红');
await page.press('[data-testid="operator-input"]', 'Enter');
const expDisabled = await page.isDisabled('table[data-testid="frame-table"] tbody tr:first-child td:nth-child(4) input');
ok('非持有人曝光输入框禁用', expDisabled);

// 8. 交接：阿明交给小红
await page.fill('[data-testid="operator-input"]', '阿明');
await page.press('[data-testid="operator-input"]', 'Enter');
await page.fill('[data-testid="auth-handover-input"]', '小红');
await page.click('[data-testid="auth-handover-btn"]');
await page.waitForTimeout(700);
ok('交接后显示当前由小红接手', (await page.textContent('[data-testid="auth-holder"]'))?.includes('小红'));
const handoverInfo = await page.textContent('[data-testid="auth-info"]');
ok('交接提示原持有人失去权限', handoverInfo?.includes('原持有人不再能改动'));

// 9. 小红成为持有人后可操作：重新确认
await page.fill('[data-testid="operator-input"]', '小红');
await page.press('[data-testid="operator-input"]', 'Enter');
const confirmBtnEnabled = await page.isEnabled('[data-testid="auth-confirm-btn"]');
ok('小红接手后确认按钮可用', confirmBtnEnabled);
await page.click('[data-testid="auth-confirm-btn"]');
await page.waitForTimeout(500);
ok('小红确认成功', (await page.textContent('[data-testid="auth-attest"]'))?.includes('已确认'));

// 10. 阿明再动帧序被权限拒绝
await page.fill('[data-testid="operator-input"]', '阿明');
await page.press('[data-testid="operator-input"]', 'Enter');
const insertForExHolder = await page.isDisabled('[data-testid="insert-frame"]');
ok('交出后原持有人插帧按钮禁用', insertForExHolder);

// 11. 总览页显示持有人与确认态
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="overview-auth"]');
const authCell = await page.textContent('[data-testid="overview-auth"]');
ok('总览显示持有人=小红且已确认', authCell?.includes('小红') && authCell.includes('已确认'), authCell);

// 12. 实拍记录页登记人列
await page.goto(BASE + '/progress', { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="take-table"]');
const takeTable = await page.textContent('[data-testid="take-table"]');
ok('实拍记录带登记人=阿明', takeTable.includes('阿明'));

const realErrors = errors.filter((e) => !e.includes('IndexedDB 初始化失败'));
ok('页面无运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(([c]) => !c).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
