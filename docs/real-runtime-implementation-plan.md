# NetHack-Chat 真实运行时实施计划

> 状态：Draft  
> 目标：把当前基于 `FakeWasmAdapter` 的中间件原型，建设成可从固定版本的原版 NetHack 源码自动构建，并通过统一中间件 API 在浏览器中运行的可用系统。  
> 最终用户体验：克隆本仓库后，通过一条初始化命令获取/构建游戏，再通过一条开发或生产命令启动。

## 1. 目标与完成标准

### 1.1 最终使用方式

默认模式由仓库自动获取锁定版本的原版 NetHack：

```bash
git clone --recurse-submodules <nethack-chat-repository>
cd NetHack-Chat
npm install
npm run bootstrap
npm run dev
```

同时支持用户提供已经克隆的原版 NetHack 源码：

```bash
git clone --branch NetHack-5.0 https://github.com/NetHack/NetHack.git ../NetHack
NETHACK_SRC=../NetHack npm run runtime:build
npm run dev
```

`bootstrap` 必须完成以下工作：

1. 检查 Node、npm、Docker 或本地 Emscripten 环境。
2. 获取锁定 commit 的 NetHack 源码及其 submodules。
3. 校验源码 revision 和必要文件。
4. 应用仓库维护的最小 shim 补丁（如确有需要）。
5. 使用固定版本的 Emscripten 构建 WASM。
6. 将 JS loader、WASM、运行时数据和许可证复制到 Web 应用资源目录。
7. 构建 TypeScript workspace。
8. 执行最小真实运行时冒烟测试。

### 1.2 产品完成标准

系统必须满足：

- 浏览器中运行真实 NetHack，而不是 fake runtime。
- 键盘、UI 按钮、聊天代理和技能共享同一条写入路径。
- `observe()` 返回稳定、仅玩家可见的结构化状态，且不推进游戏时间。
- `step()` 能执行 `move`、`wait`、`open`、`pickup`、`respond`。
- 遇到菜单、方向、是/否、more、文本和 game-over 状态时不会盲目继续发送按键。
- `executeSkill()` 可以在真实游戏上运行有预算的 `walk_to`。
- `stop()` / `takeOver()` 可以立即撤销 AI 权限，旧 epoch 的输入不会继续提交。
- 支持新游戏、保存、加载和终止会话。
- 真实运行时验收测试全部通过；不再以 fake runtime 代替交付验收。
- 构建使用固定的上游 commit、工具链版本和产物校验信息。

## 2. 非目标

首个可用版本不追求：

- 通关、全自动游戏或覆盖 NetHack 的全部命令。
- 复杂装备、施法、祈祷、商店、容器等全部交互。
- 兼容所有 NetHack 历史版本和窗口系统。
- 在服务端运行任意数量的多人游戏实例。
- 使用未经过中间件验证的原始按键自动化。
- 复刻或重写完整 NetHack WebUI。

这些能力应在真实运行时、输入边界和接管机制稳定之后扩展。

## 3. 当前基线

### 3.1 已有能力

- `packages/core` 已定义 `NetHackSession`、单写入调度器、epoch、去重、状态版本和事件日志。
- `packages/adapter-wasm` 已有符合 `GameAdapter` 接口的 `FakeWasmAdapter`。
- `packages/skills` 已有有界的 `walk_to`。
- `packages/agent` 已有结构化决策、离线 provider 和编排器。
- `apps/model-gateway` 已有 OpenAI-compatible 网关骨架。
- `eval` 已覆盖大部分中间件契约。

### 3.2 Phase 0 基线问题（已于 2026-10-02 解决）

真实运行时接入前的基线问题及处理结果：

- [x] 停止跟踪 `*.tsbuildinfo`、编译输出和生成 trace，避免增量缓存跳过必要构建。
- [x] 将 TypeScript、Node 和 npm 开发版本固定。
- [x] 修复 `walk_to` BFS 回溯条件恒为 false 的问题。
- [x] 将怪物占位保护限定到 skill 输入，恢复人类移动触发近战的正常语义。
- [x] 修复 fake runtime 的视野半径和隐藏怪物追击行为，使 demo 场景与注释一致。
- [x] 修复 Pickup 路径以及 demo 没有走到药水位置的问题。
- [x] takeover 验收稳定返回 `interrupted`。
- [x] 当前 fake 验收结果：25 passed、0 failed、2 skipped；两个 skip 为真实运行时门槛。

以下仍属于后续阶段，而不是 Phase 0 回归：

- `apps/web` 目前只是终端 demo，没有真正 Web UI。
- `vendor/UPSTREAM.md` 尚未填写固定 revision 和许可证信息。

## 4. 总体架构

```text
Web UI / Keyboard / Chat
            |
            v
      MiddlewareSession
 observe / step / skill / takeover
            |
            v
       RealWasmAdapter
 observation builder / action recipes / prompt FSM
            |
            v
       RuntimeWorkerClient
       typed request/event RPC
            |
            v
         Web Worker
     NetHack WASM + shim
            |
            v
   pinned upstream NetHack 5.0
```

核心原则：

1. `MiddlewareSession` 是唯一的语义写入入口。
2. Worker 是唯一直接接触 WASM 输入函数的组件。
3. `RealWasmAdapter` 只发送有类型的动作配方，不接受任意自动按键字符串。
4. Observation 仅在稳定输入边界发布。
5. UI 的手动控制也必须调用 `session.step()`，不能绕过调度器写 Worker。
6. 模型输出只是 proposal；由本地编排器补充 session、epoch 和 state version 后执行。

## 5. 目标目录结构

```text
NetHack-Chat/
├── apps/
│   └── web/
│       ├── public/runtime/          # 生成产物，不提交大体积构建文件
│       └── src/
│           ├── main.ts
│           ├── runtime-worker.ts
│           ├── session-host.ts
│           └── ui/
├── packages/
│   ├── adapter-wasm/src/
│   │   ├── real-runtime.ts
│   │   ├── worker-client.ts
│   │   ├── protocol.ts
│   │   ├── observation-builder.ts
│   │   ├── action-recipes.ts
│   │   ├── prompt-machine.ts
│   │   └── glyphs.ts
│   ├── runtime-worker/src/
│   │   ├── worker.ts
│   │   ├── wasm-driver.ts
│   │   └── shim-events.ts
│   └── core/
├── scripts/
│   ├── fetch-runtime.mjs
│   ├── build-runtime.mjs
│   ├── verify-runtime.mjs
│   └── package-runtime.mjs
├── vendor/
│   ├── upstream-lock.json
│   ├── patches/nethack/
│   └── licenses/
├── eval/
│   ├── fake/
│   └── real/
└── docs/
    ├── runtime-build.md
    ├── runtime-protocol.md
    └── real-runtime-implementation-plan.md
```

`.cache/upstream/`、构建中间文件和 `apps/web/public/runtime/` 应加入 `.gitignore`；只提交锁文件、补丁、脚本、协议和许可证记录。

## 6. 上游与构建策略

### 6.1 上游选择

运行时基线使用官方 NetHack 的 `NetHack-5.0` 分支，但在 `vendor/upstream-lock.json` 中固定确切 commit：

```json
{
  "nethack": {
    "repository": "https://github.com/NetHack/NetHack.git",
    "revision": "<exact-commit>",
    "branch": "NetHack-5.0"
  },
  "emscripten": {
    "version": "<exact-version>",
    "container": "<image>@sha256:<digest>"
  },
  "referenceWebUi": {
    "repository": "https://github.com/e3sh/Nethack-wasm-webUI.git",
    "revision": "<exact-commit>"
  }
}
```

`Nethack-wasm-webUI` 第一阶段作为 Driver、Worker 通信和 shim 行为的参考。是否直接复用其代码，要在完成许可证、API 和最小依赖审查后决定。不得把浮动主分支直接作为生产依赖。

### 6.2 工具链固定

- Node 固定为一个 Node 20 LTS 小版本，通过 `.nvmrc` 和/或 `package.json#engines` 记录。
- npm 使用 lockfile，CI 使用 `npm ci`。
- TypeScript 使用精确版本，不使用 `^`。
- Emscripten 使用固定版本；优先提供固定 digest 的容器镜像。
- 构建输出写入 manifest，记录 NetHack commit、shim patch hash、Emscripten 版本和文件 SHA-256。

### 6.3 补丁原则

优先使用上游已有 shim pseudo-windowport。只有缺少必要结构化信息时才加入最小补丁。

允许的补丁：

- 将 windowport 回调转为结构化事件。
- 暴露稳定输入边界和 prompt 类型。
- 暴露玩家已知的地图、状态和 inventory 信息。
- 暴露 turn、level identity、game-over 和 save/load 生命周期。

禁止的补丁：

- 改变游戏规则或 RNG 行为。
- 暴露玩家不可见的怪物、陷阱或地图真值。
- 为了方便 agent 而绕过 NetHack 正常输入语义。
- 将大规模 Web UI 改动混入 NetHack C 源码。

所有补丁放在 `vendor/patches/nethack/`，按顺序编号，并在 CI 中验证能干净应用。

## 7. Worker RPC 协议

### 7.1 Worker 命令

```ts
type RuntimeCommand =
  | { type: "boot"; requestId: string; sessionId: string; config: RuntimeConfig }
  | { type: "execute"; requestId: string; boundaryId: number; recipe: RuntimeRecipe }
  | { type: "save"; requestId: string }
  | { type: "load"; requestId: string; data: ArrayBuffer }
  | { type: "terminate"; requestId: string };
```

每个请求必须获得带同一 `requestId` 的回复。Worker 不得接受来自 agent 的 `source`、`control_epoch` 等元数据；这些由 core 管理。

### 7.2 Worker 事件

```ts
type RuntimeEvent =
  | { type: "ready"; runtimeId: string }
  | { type: "map-cell"; x: number; y: number; glyph: number; visibility: "visible" | "remembered" }
  | { type: "status"; hp: number | null; maxHp: number | null; conditions: string[]; turn: number }
  | { type: "message"; text: string }
  | { type: "inventory"; items: RuntimeInventoryItem[] }
  | { type: "prompt"; prompt: RuntimePrompt }
  | { type: "input-boundary"; boundaryId: number; turn: number; levelId: string }
  | { type: "recipe-result"; requestId: string; outcome: RuntimeOutcome }
  | { type: "game-over"; reason: string }
  | { type: "fatal"; message: string };
```

### 7.3 稳定边界定义

以下状态可以发布 Observation：

- 主命令等待状态。
- 已结构化的方向、菜单、yes/no、more 或文本输入状态。
- game-over 状态。

以下时刻不可发布新的稳定 Observation：

- C 引擎正在处理命令。
- 地图和状态窗口只更新了一部分。
- 连续 prompt 的中间阶段尚未被识别。
- save/load 正在替换文件系统状态。

每到达一次稳定边界：

1. 完成本批地图、状态、消息、实体和 inventory 聚合。
2. 生成新的不可变 Observation。
3. 若任何玩家可见状态或输入状态变化，则递增 `state_version`。
4. 发布 `input-boundary` 和对应 snapshot。

## 8. Observation 构建

`observation-builder.ts` 负责把 shim/driver 事件映射到现有 `Observation`。

### 8.1 地图

- 坐标原点为左上角，x 向东，y 向南。
- glyph 转换必须基于固定 NetHack build 的 glyph 定义。
- 区分 `visible` 和 `remembered`。
- 未见过的格子不输出，或输出为明确 `unknown`；不得输出游戏内部真值。
- entity 只包含当前玩家可见实体，不保留过期怪物坐标。
- entity reference 只保证在当前 `state_version` 内有效。

### 8.2 玩家状态

- HP、最大 HP、conditions 来源于状态窗口或窄 shim API。
- 无法可靠得知的字段保持 `null`，不得猜测。
- `turn` 必须来自引擎或可靠生命周期信号，不能用输入计数替代。

### 8.3 Inventory

`observe()` 不得为了刷新 inventory 偷偷发送 inventory 按键。优先方案：

1. 从 NetHack inventory/window callbacks 获得玩家已经知道的信息。
2. 若上游 shim 没有可靠回调，增加只读 shim export。
3. 在无法获得新快照时保留最后一次玩家已知数据，并明确其生命周期。

### 8.4 Prompt

Prompt 必须结构化为现有 `InputState`：

- `command`
- `direction`
- `menu`
- `yes_no`
- `more`
- `text`
- `game_over`

优先使用 shim 的调用类型；文本正则只能作为兼容层，不能是核心正确性的唯一依据。

## 9. 动作配方与 Prompt 状态机

### 9.1 第一批动作

- `move(direction)`
- `wait`
- `open(direction)`
- `pickup`
- `respond(promptId, response)`

### 9.2 执行规则

每个语义动作由有限状态配方执行：

```text
开始动作
  -> 发送一个预期输入
  -> 等待运行时边界或 prompt
  -> 验证实际状态是否属于配方允许集合
  -> 必要时发送下一输入
  -> settled / needs_input / unexpected_prompt / terminal / failed
```

例如 `open(direction)`：

```text
command boundary
  -> 发送 open 命令
  -> 必须收到 direction prompt
  -> 发送方向
  -> 等待 command、more、其他 prompt 或 game-over
```

如果未收到预期的 direction prompt，不得继续发送方向键，返回 `unexpected_prompt`。

### 9.3 Prompt ID

- 每次 shim 进入新 prompt 时生成单调递增的 prompt ID。
- `respond` 必须同时匹配 `promptId` 和当前 prompt 类型。
- prompt 解决后立即失效。
- load/restart 后重置命名空间或加入 session generation，避免旧 ID 冲突。

## 10. 保存、加载和会话生命周期

浏览器运行时优先采用 Emscripten 文件系统加 IndexedDB：

- 新游戏：创建新的 session generation。
- 保存：等待稳定边界，flush 虚拟文件系统，再导出或持久化。
- 加载：停止当前写入、递增 epoch、清空队列、替换文件系统、重新启动并等待稳定边界。
- game over：Observation 标记 `terminal=true`，拒绝后续普通动作。
- terminate：停止 Worker 并释放监听器、定时器和 WASM 资源。

首版只要求单浏览器、单活动会话。多会话放在后续里程碑。

## 11. Web 客户端最小范围

第一版 Web UI 只实现可验证闭环：

- 地图区域。
- 玩家状态和消息区域。
- 聊天输入与输出。
- 当前 interaction mode。
- Stop 和 Take Over 按钮。
- 当前 prompt 对话框。
- 键盘方向、等待、开门和拾取。
- 新游戏、保存和加载。
- 明确显示 runtime ID 和是否为真实 NetHack。

键盘事件必须转换成 `GameAction` 并调用 `session.step()`。不得把键盘事件直接转发给 WASM Worker。

## 12. 测试策略

### 12.1 测试分层

```text
Unit
  protocol / glyph mapping / prompt FSM / recipes / observation builder

Contract
  所有 GameAdapter 实现运行同一套 adapter contract tests

Integration
  真实 WASM Worker + 固定存档/固定场景

End-to-end
  浏览器 UI + session + Worker + WASM
```

### 12.2 Fake Runtime 的定位

Fake runtime 保留用于快速单元测试，但：

- 必须修复当前 5 个失败用例。
- 不得作为真实运行时验收的替代品。
- `eval:fake` 和 `eval:real` 必须分开报告。

### 12.3 Real Runtime 必测场景

1. 启动后到达 command boundary。
2. 连续两次 `observe()` 不推进 turn。
3. 移动一步产生正确位置和 turn 变化。
4. 撞墙不会破坏边界同步。
5. `open` 正确处理 direction prompt。
6. 错误 prompt ID 不向运行时提交输入。
7. `pickup` 能处理零件物品、单件物品和菜单。
8. `--More--` 会停止配方并正确暴露 prompt。
9. game-over 转为 terminal Observation。
10. 重复 request ID 不执行两次。
11. stale state version 不执行。
12. stale control epoch 不执行。
13. skill 执行中 takeover 后不再有新提交。
14. 保存并加载后状态可恢复。
15. Observation 不泄漏未见地图、怪物或未识别属性。

### 12.4 测试可重复性

优先使用：

- 固定运行时 build。
- 固定配置文件。
- 可控角色创建选项。
- 专用测试关卡或固定存档。
- 事件 trace 与 expected invariants。

不应把完整游戏过程的逐字消息或 RNG 结果作为唯一断言。

## 13. CI 与发布

CI 分为两层：

### 快速 CI

每个提交运行：

```bash
npm ci
npm run typecheck
npm run test
npm run eval:fake
```

### 真实运行时 CI

在 runtime、adapter、core 或构建脚本变化时运行：

```bash
npm run runtime:fetch
npm run runtime:build
npm run runtime:verify
npm run eval:real
npm run test:e2e
```

缓存键必须包含：

- NetHack commit
- 补丁 hash
- Emscripten image digest
- build script hash

发布包必须包含 `runtime-manifest.json` 和上游许可证/notice。

## 14. 分阶段实施

### Phase 0：稳定当前仓库

任务：

- [x] 固定 Node、npm 和 TypeScript 版本。
- [x] 停止跟踪 `*.tsbuildinfo` 和生成 trace。
- [x] 修复 clean/build 流程，确保全新 clone 后 `npm ci && npm run typecheck` 成功。
- [x] 修复 demo 的 `walk_to` 失败。
- [x] 修复 Pickup 的 4 个验收失败。
- [x] 修复 takeover 结果竞争。
- [x] 将 fake 验收恢复到 0 failed。

退出条件：

- `npm ci && npm run typecheck && npm run eval:fake` 在干净 checkout 中稳定通过。

完成记录：依赖安装成功；干净重建后 fake 验收为 25 passed、0 failed、2 skipped，demo 的委派、接管和拾取断言通过。

### Phase 1：上游锁定与可重复 WASM 构建

任务：

- [x] 选择并记录 NetHack exact commit。
- [x] 固定 Emscripten 版本和容器 digest。
- [x] 完成许可证核查并记录上游 notice。
- [x] 实现 `runtime:fetch`。
- [x] 实现 `runtime:build`。
- [x] 生成 `runtime-manifest.json`。
- [x] 在浏览器中启动原始 WASM，完成手动输入冒烟测试（Node 初始化、导出函数和内嵌数据检查已通过）。
- [x] 把实际命令和产物记录到 `docs/runtime-build.md`。

阶段记录：本地 Emscripten 4.0.23 编译官方 NetHack 5.0 成功；Node 和 Chrome 均能初始化 `nethack.js` / `nethack.wasm`，并确认游戏数据与 license 已嵌入。首次编译暴露了上游脚本对 `targets/wasm/wasm-data` 目录的依赖，项目构建入口会显式创建该目录。浏览器内启动游戏并响应首个输入 prompt 的手动冒烟测试尚未完成。

退出条件：

- 全新环境一条命令能构建并启动真实 NetHack。
- 同一输入 revision 能产生可验证的运行时产物。

### Phase 2：Worker 与事件探针

任务：

- [x] 梳理 shim windowport 的地图、状态、消息、菜单、输入和退出回调。
- [x] 定义并测试 Worker RPC。
- [x] 识别可靠的主命令边界。
- [x] 输出地图、状态、消息、prompt 和 game-over 事件（状态目前是 raw callback 数据，尚未解码）。
- [x] 记录无法从原始 shim 获得的字段。
- [x] 如必要，编写最小 C shim 补丁（当前 Worker 侧 ABI 兼容即可，无需 C 补丁）。

退出条件：

- Worker 能启动游戏，并在不依赖 UI DOM 的情况下输出稳定结构化事件。

### Phase 3：RealWasmAdapter

任务：

- [ ] 实现 `RuntimeWorkerClient`。
- [ ] 实现 `ObservationBuilder`。
- [ ] 实现 glyph/terrain/entity 映射。
- [ ] 实现 prompt 状态机。
- [ ] 实现五个 MVP 动作配方。
- [ ] 实现 runtime 错误、未知提交和重连处理。
- [ ] 运行通用 adapter contract tests。

退出条件：

- `MiddlewareSession` 可以用 `RealWasmAdapter` 完成 observe、move、open、pickup 和 respond。

### Phase 4：中间件安全性与技能

任务：

- [ ] 在真实运行时验证 stale/duplicate 请求零输入。
- [ ] 验证单写入队列。
- [ ] 验证 Stop/Take Over。
- [ ] 让 `walk_to` 在真实地图上运行。
- [ ] 验证遇怪、低 HP、未知 prompt、换层和 game-over 停止条件。
- [ ] 输出可回放的 JSONL trace。

退出条件：

- `eval:real` 的控制、打断、技能和可见性用例全部通过。

### Phase 5：最小可用 Web 产品

任务：

- [ ] 接入构建工具和开发服务器。
- [ ] 实现地图、状态、消息和 prompt UI。
- [ ] 实现键盘到 typed action 的映射。
- [ ] 接入离线 provider 和模型网关 provider。
- [ ] 实现 interaction modes、Stop 和 Take Over。
- [ ] 实现保存/加载。
- [ ] 增加 E2E 测试和生产构建。

退出条件：

- 用户可以从 clone 到启动，完整玩一局真实 NetHack，并在聊天和手动控制之间切换。

### Phase 6：打包与开发者体验

任务：

- [ ] 完善 `npm run bootstrap`。
- [ ] 支持外部 `NETHACK_SRC`。
- [ ] 提供构建缓存和离线重建说明。
- [ ] 提供故障诊断命令 `npm run doctor`。
- [ ] 更新 README 快速开始。
- [ ] 增加发布包、许可证、版本信息和升级流程。

退出条件：

- macOS 和 Linux 的干净环境均能按文档成功启动。
- 构建失败时能给出明确缺失依赖、revision 或工具链错误。

## 15. 风险与应对

### 15.1 输入边界不可靠

风险：仅根据文本或 UI 更新猜测游戏何时等待输入，容易产生竞态。

应对：优先从 shim 输入函数和 windowport 生命周期发出明确 boundary；必要时增加窄 C hook。

### 15.2 玩家不可见信息泄漏

风险：直接读取游戏内部地图或怪物数组可能向 agent 暴露隐藏信息。

应对：Observation 只由 windowport 已显示的数据和玩家知识接口构建；为不可见性建立专门测试。

### 15.3 Prompt 识别依赖英文文本

风险：语言、版本或消息变化会破坏正则。

应对：使用输入 API 类型作为主信号，文本只用于展示和兼容；对每类 prompt 建立协议测试。

### 15.4 上游变化

风险：NetHack 5.0 和参考 WebUI 都在变化。

应对：固定 commit；升级通过单独 PR 完成，包含补丁重放和真实验收结果。

### 15.5 WASM 构建复杂

风险：用户本地缺少兼容 Emscripten、make、Python 或系统工具。

应对：默认提供固定容器构建；本地 emsdk 作为高级选项；`doctor` 在构建前检查环境。

### 15.6 Save/Load 与 epoch 不一致

风险：加载旧存档后，旧队列或旧 prompt 响应仍可能执行。

应对：load 必须先 stop、递增 epoch、清空队列、重建 Worker generation，然后发布新 Observation。

## 16. 关键决策记录

实施过程中至少需要补充以下 ADR：

1. `ADR-003-upstream-and-toolchain-pinning.md`
2. `ADR-004-worker-runtime-protocol.md`
3. `ADR-005-player-visible-observation-source.md`
4. `ADR-006-runtime-patch-policy.md`
5. `ADR-007-save-load-and-session-generation.md`

如果决定直接复用 `Nethack-wasm-webUI` 的代码，还需要记录：

- 复用范围。
- 许可证结论。
- 与本项目协议之间的隔离层。
- 后续升级和替换成本。

## 17. 第一批实施任务

按以下顺序开始，避免同时修改过多层：

1. 完成 Phase 0，让 fake 基线全绿。
2. 调研并固定官方 NetHack 与 Emscripten revision。
3. 只实现构建，不立即接中间件。
4. 在独立 Worker spike 中捕获真实回调和输入边界。
5. 根据实际回调完善 `runtime-protocol.md`。
6. 实现只读 `RealWasmAdapter.start()` 和 `snapshot()`。
7. 首先接通 `wait`，再接 `move`，然后接有 prompt 的 `open`。
8. 接通 `pickup` 和通用 `respond`。
9. 运行真实 adapter contract tests。
10. 最后接 `walk_to`、聊天和 Web UI。

第一批 PR 建议只包含 Phase 0，不混入 WASM 构建；第二批 PR 只完成可重复构建和 runtime manifest；第三批 PR 再引入 Worker 协议和 adapter。

## 18. 参考资料

- [NetHack 官方仓库](https://github.com/NetHack/NetHack)
- [NetHack 5.0 Cross-compiling](https://github.com/NetHack/NetHack/blob/NetHack-5.0/Cross-compiling)
- [Nethack-wasm-webUI](https://github.com/e3sh/Nethack-wasm-webUI)
- [Emscripten 官方文档](https://emscripten.org/docs/getting_started/downloads.html)
- 本仓库的 [runtime spike 说明](runtime-spike.md)
- 本仓库的 [中间件契约](contracts.md)
