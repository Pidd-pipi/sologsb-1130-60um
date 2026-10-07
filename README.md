# 定格动画拍摄帧序编排台（gbstopmotion）

面向定格动画的动画师与摄影助理，把镜头拆分、逐帧位移量与拍摄参数记录成可执行的拍摄清单：新建镜头后按帧率与时长自动排帧区间，在帧序条带上插入、删除、移动帧并重算时长，随拍随记曝光参数与实拍张数。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21830>

停止（镜像保留）：

```bash
docker compose down
```

## 技术栈

| 层 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 + `vue-tsc -b`（类型检查零错误） |
| 状态 | Pinia（`shotStore` / `frameStore` / `uiStore`） |
| 路由 | Vue Router 4（HTML5 History，nginx `try_files` 兜底） |
| UI | Element Plus + 自研轻量组件 |
| 本地存储 | IndexedDB（Dexie，库名 `gbstopmotion-db`）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（多阶段构建，gzip + 前端路由回落） |

## 目录结构

```
sologsb-1130/
├── docker-compose.yml        # 顶层 name: gbstopmotion，端口 ${FRONTEND_PORT:-21830}
├── .env / .env.example       # COMPOSE_PROJECT_NAME=gbstopmotion
└── frontend/
    ├── Dockerfile            # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf            # try_files $uri $uri/ /index.html + gzip
    ├── public/favicon.svg
    └── src/
        ├── types/{shot,frame,prop,take}.ts        # 4 个数据模型
        ├── stores/{shotStore,frameStore,uiStore}.ts
        ├── components/common/{FrameStrip,ExposureForm,ShotProgress,StatusTag,EmptyState}.vue
        ├── hooks/{useFrameSequence,useProgress,useLocalDraft}.ts
        ├── pages/{Overview,ShotNew,ShotDetail,FrameBoard,PropTrack,TakeLog}.vue
        ├── router/index.ts
        ├── utils/{frameMath,exposure,format}.ts
        └── db/{index,api}.ts                      # Dexie 实例（v1→v3 升级迁移）与读写层
```

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 进度总览 | 各镜头状态、帧数、预计时长、完成百分比，累计全片张数与待拍张数 |
| `/shots/new` | 新建镜头 | 填写镜号、场景名、帧率与时长，保存后生成帧区间与首位帧条目 |
| `/shots/:id` | 镜头详情 | 镜头参数与进度、帧序条带、帧条目表格、道具轨迹、登记实拍 |
| `/frames` | 帧序编排台 | 移动/插入/删除帧、批量套用曝光，改动后重算序号与总时长 |
| `/props` | 道具位移轨迹 | 按镜头与帧区间登记 X/Y/Z 与旋转角度，曲线预览累计位移 |
| `/progress` | 实拍记录 | 登记当日实拍张数与废帧数，回写完成百分比并提示剩余张数 |

## 拍摄授权与实拍确认（换班台账）

每条镜头持有一份**拍摄授权**，把口头交接变成页面上可核对的记录：

| 规则 | 实现 |
| --- | --- |
| 只有持有人能登记实拍张数 | 顶栏设置「当前操作员」；登记 / 删除实拍仅持有人可用，数据层（IndexedDB 事务）二次校验，非持有人直接权限拒绝 |
| 只有持有人能改帧序或曝光 | 插入 / 删除 / 移动帧、批量与单帧曝光、帧率 / 时长调整均持有人专属；授权交出后原持有人再动帧序或曝光会被拒绝 |
| 页面显示现在由谁接手 | 镜头详情、帧序编排台、实拍记录页均有授权卡（当前持有人、授权版本、最近交接时间）；总览页列出持有人与确认状态 |
| 帧序/曝光一改动，已确认进度立刻作废 | `frameVersion` 随帧序/曝光改动 +1，`progressConfirmed` 置 false，完成百分比按当前帧序与累计实拍即时重算 |
| 作废后由持有人重新确认 | 持有人点「确认实拍进度」，固化确认时的帧序/曝光版本与实拍张数快照；张数再变动同样作废 |
| 旧数据升级回填授权 | Dexie **v4** 迁移：按镜头原负责人 `owner` 回填持有人，负责人为空则授权挂起待认领；既有实拍一次性视为已确认，登记人回填为原负责人 |
| 写失败恢复原样 | 帧+镜头+实拍、实拍登记、授权交接均在同一 IndexedDB 事务内提交，任一步失败整体回滚——授权与实拍都恢复成操作前原样 |

顶栏输入姓名即切换当前操作员（模拟换班登录，保存在 localStorage `gbstopmotion:operator`）。

## 数据存储

- **IndexedDB（Dexie，`gbstopmotion-db`）**：镜头、帧条目、道具状态、实拍记录四张表。
  版本迁移：`v1` 建 `shots` / `frames`；`v2` 增加 `props` 表与 `shotId` 索引；`v3` 增加 `takes` 表并按实拍张数回填进度；`v4` 增加拍摄授权与实拍确认字段，旧数据按负责人回填授权。
- **localStorage**：新建镜头表单与批量曝光参数草稿，键前缀 `gbstopmotion:draft:`。
- 全部数据存在浏览器本地，容器无状态、不使用数据库服务、不挂载命名卷，无任何后端接口调用。
