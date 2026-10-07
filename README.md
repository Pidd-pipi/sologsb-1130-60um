# 定格动画拍摄帧序编排台（gbstopmotion）

面向定格动画的动画师与摄影助理，把镜头拆分、逐帧位移量与拍摄参数记录成可执行的拍摄清单：新建镜头后按帧率与时长自动排帧区间，在帧序条带上插入、删除、移动帧并重算时长，随拍随记曝光参数与实拍张数。

## 拍摄授权（换班交接）

每条镜头配一份**拍摄授权**（`permits` 表），解决换班时"谁在拍哪条镜头、谁动过曝光"对不上的问题：

- **持有人才能登记实拍张数**：页头设置「当前操作人」后，系统按操作人与授权持有人比对放行。
- **交接后原持有人被权限拒绝**：持有人在镜头详情页把授权交接给接任人；此后原持有人再动帧序或曝光会被权限拒绝，页面提示当前由谁接手。
- **改动即作废重算**：帧序或曝光一有改动，该镜头已确认的实拍进度立刻作废为「待确认」并重算完成度，需持有人重新确认后才计回进度。
- **授权待认领**：负责人为空的镜头授权显示「待认领」，任何人设置操作人后可认领为持有人。
- 交接轨迹（谁交给谁、何时）保留在授权记录里，镜头详情页可查。

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
| 状态 | Pinia（`shotStore` / `frameStore` / `permitStore` / `uiStore`） |
| 路由 | Vue Router 4（HTML5 History，nginx `try_files` 兜底） |
| UI | Element Plus + 自研轻量组件 |
| 本地存储 | IndexedDB（Dexie，库名 `gbstopmotion-db`）+ localStorage（表单草稿、当前操作人） |
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
        ├── types/{shot,frame,prop,take,permit}.ts      # 5 个数据模型
        ├── stores/{shotStore,frameStore,permitStore,uiStore}.ts
        ├── components/common/{FrameStrip,ExposureForm,ShotProgress,StatusTag,EmptyState}.vue
        ├── hooks/{useFrameSequence,useProgress,usePermit,useLocalDraft,takeCache}.ts
        ├── pages/{Overview,ShotNew,ShotDetail,FrameBoard,PropTrack,TakeLog}.vue
        ├── router/index.ts
        ├── utils/{frameMath,exposure,format}.ts
        └── db/{index,api}.ts                      # Dexie 实例（v1→v4 升级迁移）与读写层
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

## 数据存储

- **IndexedDB（Dexie，`gbstopmotion-db`）**：镜头、帧条目、道具状态、实拍记录、拍摄授权五张表。
  版本迁移：`v1` 建 `shots` / `frames`；`v2` 增加 `props` 表与 `shotId` 索引；`v3` 增加 `takes` 表并按实拍张数回填进度；`v4` 增加 `permits` 表，按负责人回填授权、旧实拍标记为已确认——升级运行在版本变更事务里，任一步写入失败都会整体回滚，授权与实拍恢复原样。
- **localStorage**：新建镜头表单与批量曝光参数草稿（键前缀 `gbstopmotion:draft:`），当前操作人（`gbstopmotion:operator`）。
- 全部数据存在浏览器本地，容器无状态、不使用数据库服务、不挂载命名卷，无任何后端接口调用。
