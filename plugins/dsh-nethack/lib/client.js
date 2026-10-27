// dsh-nethack — browser half.
//
// Renders the NetHack game as a central panel, reached from a single top-left
// entry: the player's unframed "@" in the sidebar's global panel list. The entry
// id and the `main` slot key are the same string, which is what makes clicking the
// icon open this page; the shipped Schedule Manager wires its own panel the same
// way. The panel is laid out like a conversation — the map, status and game read
// out fill the space, and the chat box that drives the model floats at the bottom
// where a composer would sit.
//
// The model drives the same game through the nethack_observe/nethack_act/
// nethack_respond tools on the Host, and this panel posts to the same Host
// methods, so hand-play and model-play share one engine. Those tools are handed to
// this panel's conversation directly and are NOT registered in the shared tool
// registry, so no other conversation in the profile can see or call them.
//
// Plain JavaScript and no JSX: React arrives from the browser module table,
// every visible string goes through the locale service, and the look comes
// from the host's `--dsw-alias-*` theme tokens.

window.__ModuleLoader__.load({
  // The client-modules registry keys a bundle by its package name, so this must
  // match package.json. It is not the plugin id: slots, routes and storage keys
  // below still use "dsh-nethack".
  id: "@yeaszn/dsh-neth4ck",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = "dsh-nethack";

    /**
     * Key of the central-panel body. The game is normally reached through the
     * right-column tab, but the same component also serves the `main` slot under
     * this key, so the panel still renders if anything ever selects it.
     */
    const PANEL_ID = "nethack";
    /** The right-column tab id; a separate key from the centre panel. */
    const TAB_ID = "nethack/game";

    /**
     * The agent preset the Host declares for the game's session.
     *
     * Must match `GAME_PRESET` in `lib/session.mjs` and the `id` in this
     * package's `cordis.patch.yml`: the preset is what gives the session its
     * NetHack persona and its compaction rows.
     */
    const GAME_PRESET = "nethack";

    /**
     * The panel body, and the conversation seat inside it.
     *
     * Two slots because DSH's Conversation reads its session from a React
     * context that only a `session`-scoped slot provides:
     *
     *   main / sidebar tab  ->  PANEL_SLOT (session-maybe)  ->  NetHackPanel
     *                             └─ CONV_SLOT (session)     ->  the shipped chat
     *
     * The panel binds `SessionProvider` to the GAME's session around `CONV_SLOT`,
     * so the conversation below renders for the game rather than for whatever
     * session the person is looking at. Private names: slots are a global
     * registry keyed by name, so reusing a shipped name would make the two
     * render into each other.
     */
    const PANEL_SLOT = "nethack.panel.body";
    const CONV_SLOT = "nethack.panel.conversation";

    /** Read routes owned by this package's Host half. */
    const ROUTE_STATE = "/api/dsh-nethack.state";
    const ROUTE_ACTION = "/api/dsh-nethack.action";
    const ROUTE_SESSION = "/api/dsh-nethack.session";

    /**
     * Glyph colours by tty character, matching NetHack's own screen classes.
     *
     * Order matters where two objects share a glyph: a closed door is drawn as
     * `+` and so is a spellbook, and a tile that is not a known object is
     * almost always the door, so `+` is a door here. `░` is this panel's own
     * mark for a cell the engine never drew (not the engine's `?`, which is a
     * scroll), so it gets its own dim class instead of reading as an object.
     */
    const GLYPH_CLASS = {
      "@": "hero",
      "<": "stairs", ">": "stairs",
      "#": "corridor", ".": "floor",
      "░": "blind",
      "$": "gold", "*": "gold", "!": "potion", "?": "scroll", "%": "food",
      "/": "weapon", ")": "weapon", "(": "weapon", "[": "armor", "=": "ring",
      '"': "amulet", "+": "door", "\\": "tool",
      "-": "wall", "|": "wall", "^": "trap",
    };

    /** Monster letters, so wildlife is never drawn as an item. */
    const MONSTER_LETTER = /^[a-zA-Z]$/;

    /** How long a poll may wait for the engine to reach a prompt. */
    const POLL_VISIBLE_MS = 700;
    const POLL_HIDDEN_MS = 2500;

    const DICTIONARIES = {
      en: {
        panel: "NetHack",
        refresh: "Refresh now",
        inventory: "Pack",
        noInventory: "Your pack is empty. Nothing is carried yet.",
        loading: "Starting NetHack…",
        unreachable: "Could not reach the game",
        asking: "The game is asking",
        reply: "Your answer",
        answer: "Answer",
        more: "Space or Enter to continue",
        yn: "Yes or no?",
        line: "Type your answer:",
        menu: "Choose an option by its key.",
        position: "The game wants a position on the map (travel/farlook). Direction keys move a cursor here — cancel with Escape.",
        waiting: "Waiting for your reply.",
        emptyMap: "(no map yet)",
        ac: "AC", gold: "Gold", turn: "Turn",
        hp: "HP", pw: "Pw", str: "Str", lvl: "Lv", status: "Status",
        chatFailed: "This game's conversation could not start",
        restart: "New game", keys: "Key controls", restartConfirm: "Discard this game and start over?",
        confirmRestart: "Discard and restart", cancel: "Cancel",
        manualHint: "Arrows or numpad to move; keys are captured only while this console is focused.",
        waitAction: "Wait", eatAction: "Eat",
        actPickup: "Pick up", actSearch: "Search", actOpen: "Open",
        actDescend: "Down", actAscend: "Upstairs",
        keyReply: "Key / answer", continueAction: "Space", enterAction: "Enter", escapeAction: "Esc",
        captured: "Keyboard captured", notCaptured: "Click to capture keys",
        chatStarting: "Starting this game's conversation…",
        chatAttaching: "Giving this conversation the game…",
        tabChat: "AI partner", tabPack: "Pack", tabLog: "Messages",
        seeAllMessages: "All messages", messages: "Messages",
        noMessages: "No messages yet.",
        legend: "Map key", legendBtn: "Explain the map symbols",
        legendHero: "You", legendPet: "Your pet", legendMonster: "Monster",
        legendFloor: "Room floor", legendCorridor: "Corridor (walkable)", legendWall: "Wall",
        legendDoor: "Closed door", legendStairs: "Stairs", legendTrap: "Seen trap",
        legendItem: "Item", legendBlind: "Unseen cell: not floor, not wall",
        gameOver: "The game is over. Start a new one to continue.",
      },
      zh: {
        panel: "NetHack 地牢",
        refresh: "立即刷新",
        inventory: "背包",
        noInventory: "背包是空的，还没有捡到任何东西。",
        loading: "正在启动 NetHack……",
        unreachable: "无法连接游戏",
        asking: "游戏正在询问",
        reply: "你的回答",
        answer: "回答",
        more: "按空格或回车继续",
        yn: "是或否？",
        line: "请输入回答：",
        menu: "请按键选择一项。",
        position: "游戏要你在地图上选一个位置（旅行/查看）：这里方向键移动的是光标，不是角色，按 Esc 取消。",
        waiting: "等待你的回答。",
        emptyMap: "（尚未绘制地图）",
        ac: "防御", gold: "金币", turn: "回合",
        hp: "生命", pw: "法力", str: "力量", lvl: "等级", status: "状态",
        chatFailed: "这一局的对话没能启动",
        restart: "重开游戏", keys: "按键操作", restartConfirm: "放弃当前进度，开始新的一局？",
        confirmRestart: "确认重开", cancel: "取消",
        manualHint: "方向键或小键盘移动；仅聚焦这个区域时接管按键，不影响聊天输入。",
        waitAction: "等待", eatAction: "吃",
        actPickup: "拾取", actSearch: "搜索", actOpen: "开门",
        actDescend: "下楼", actAscend: "上楼",
        keyReply: "按键／回答", continueAction: "空格", enterAction: "回车", escapeAction: "取消",
        captured: "键盘已接管", notCaptured: "点击接管键盘",
        chatStarting: "正在为这一局创建对话……",
        chatAttaching: "正在把游戏接入这个对话……",
        tabChat: "AI 搭档", tabPack: "背包", tabLog: "消息",
        seeAllMessages: "全部消息", messages: "消息",
        noMessages: "还没有消息。",
        legend: "地图图例", legendBtn: "图例：解释地图符号",
        legendHero: "你", legendPet: "你的宠物", legendMonster: "怪物",
        legendFloor: "房间地板", legendCorridor: "走廊（可通行）", legendWall: "墙",
        legendDoor: "关着的门", legendStairs: "楼梯", legendTrap: "已知陷阱",
        legendItem: "物品", legendBlind: "未知格：既不是地板也不是墙",
        gameOver: "游戏已结束，开一局新的继续。",
      },
    };

    // Layout: the game gets the left column and the conversation the right one.
    //
    // It used to be stacked (map on top, chat below, 2:3), which made the map the
    // smaller half and forced it to shrink to unreadable sizes whenever the
    // window got short. Now the map owns a full-height column and only the right
    // column can be squeezed; the container query below collapses to one column
    // for a narrow dock (the right-column tab) instead of cramping both.
    //
    // Every colour is a real host theme token, so light and dark both follow.
    const CSS = `
.nhc-root { display: flex; flex-direction: column; height: 100%; min-height: 0;
  box-sizing: border-box; overflow: hidden;
  color: var(--dsw-alias-label-primary); font-size: 12px; }
/* The main slot reaches the top of the desktop window, including when the
   sidebar is collapsed. Reserve the host's traffic-light clearance OUTSIDE the
   scrolling canvas so messages cannot scroll back under the window buttons.
   Docked tabs already have host chrome; browsers and fullscreen need no inset. */
html[data-platform="darwin"]:not([data-fullscreen]) .nhc-root[data-placement="main"] {
  padding-top: var(--dsh-frame-top-clearance, 48px); }

/* ---- the two-column body ------------------------------------------------ */
.nhc-body { flex: 1 1 auto; min-height: 0; display: grid; gap: 0;
  grid-template-columns: minmax(0, 1fr) clamp(280px, 32%, 360px);
  grid-template-rows: auto minmax(0, 1fr); }
.nhc-hud { grid-column: 1 / -1; }
.nhc-play { grid-column: 1; grid-row: 2; min-width: 0; min-height: 0; }
.nhc-side { grid-column: 2; grid-row: 2; min-height: 0; }
/* A narrow dock has no room for two columns: keep the game first, put the side
   under it, and let the whole panel scroll rather than squeeze either. */
@container (max-width: 780px) {
  .nhc-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto;
    overflow-y: auto; }
  .nhc-play { grid-row: auto; }
  .nhc-side { grid-row: auto; min-height: 340px; border-left: 0;
    border-top: 1px solid var(--dsw-alias-border-l1); }
  .nhc-stats .nhc-stat-extra { display: none; }
}
.nhc-root { container-type: inline-size; }

/* ---- HUD: who/where, HP and Pw bars, facts, conditions, actions ---------- */
.nhc-hud { flex: none; display: flex; align-items: center; gap: 16px;
  padding: 9px 14px; min-width: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-module-platform); }
.nhc-who { display: flex; align-items: center; gap: 9px; min-width: 0; flex: none; }
.nhc-avatar { width: 32px; height: 32px; flex: none; border-radius: 9px; display: grid; place-items: center;
  font: 700 17px ui-monospace, SFMono-Regular, Menlo, monospace; font-style: normal;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.nhc-who b { display: block; font-size: 12.5px; font-weight: 600; white-space: nowrap;
  max-width: 150px; overflow: hidden; text-overflow: ellipsis; }
.nhc-who span { display: block; font-size: 10.5px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary); }
.nhc-bars { display: flex; flex-direction: column; gap: 5px; flex: 0 1 190px; min-width: 120px; }
.nhc-bar { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 6px;
  font-size: 10px; color: var(--dsw-alias-label-secondary); }
.nhc-bar-track { height: 6px; border-radius: 99px; overflow: hidden;
  background: var(--dsw-alias-interactive-bg-hover);
  border: 1px solid var(--dsw-alias-border-l1); }
.nhc-bar-fill { height: 100%; border-radius: 99px; transition: width .3s ease;
  background: var(--dsw-alias-state-success-primary); }
.nhc-bar.mid .nhc-bar-fill { background: var(--dsw-alias-state-warn-primary); }
.nhc-bar.low .nhc-bar-fill { background: var(--dsw-alias-state-error-primary); }
.nhc-bar.pw .nhc-bar-fill { background: var(--dsw-alias-brand-primary); }
.nhc-bar em { font: 600 10.5px ui-monospace, monospace; font-style: normal; text-align: right;
  font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.nhc-stats { display: flex; gap: 13px; min-width: 0; overflow: hidden; }
.nhc-stat b { display: block; font: 600 13.5px ui-monospace, monospace; line-height: 1.15;
  font-variant-numeric: tabular-nums; white-space: nowrap; }
.nhc-stat span { display: block; font-size: 9.5px; letter-spacing: .04em; white-space: nowrap;
  color: var(--dsw-alias-label-secondary); }
.nhc-conds { display: flex; gap: 5px; flex-wrap: wrap; flex: 1 1 auto; min-width: 0; justify-content: flex-end; }
.nhc-cond { font-size: 10px; padding: 2px 8px; border-radius: 99px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); }
.nhc-cond.bad { color: var(--dsw-alias-state-error-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent); }
.nhc-hud-actions { display: flex; gap: 5px; flex: none; }

/* ---- buttons shared by every surface ------------------------------------ */
.nhc-btn { font: inherit; font-size: 12px; display: inline-flex; align-items: center; justify-content: center;
  gap: 5px; min-height: 28px; padding: 0 9px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); transition: background .1s, border-color .1s; }
.nhc-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l2); }
.nhc-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.nhc-btn:disabled { opacity: .42; cursor: not-allowed; }
.nhc-btn kbd { font: 700 10px ui-monospace, monospace; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-interactive-bg-hover); border-radius: 4px; padding: 1px 5px; }
.nhc-ib { font: inherit; width: 30px; height: 30px; flex: none; padding: 0; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; font-size: 14px;
  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.nhc-ib:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.nhc-ib:disabled { opacity: .42; cursor: not-allowed; }

/* ---- the game column: stage + console ----------------------------------- */
.nhc-play { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px 12px; }
.nhc-stage { position: relative; flex: 1 1 auto; min-height: 180px; display: flex;
  align-items: center; justify-content: center; padding: 34px 10px 24px;
  border-radius: 12px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); }
/* The engine's last lines float over the map instead of taking rows from it.
   Older lines fade so the newest one is the one being read. */
.nhc-overlay { position: absolute; top: 8px; left: 10px; right: 10px; display: flex;
  align-items: flex-start; gap: 8px; pointer-events: none; }
.nhc-overlay-log { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.nhc-overlay-log p { margin: 0; font-size: 11.5px; line-height: 1.35; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary); }
.nhc-overlay-log p:nth-last-child(n+3) { opacity: .5; }
.nhc-overlay-log p:last-child { color: var(--dsw-alias-label-primary); }
.nhc-overlay-log p:last-child::before { content: "›"; margin-right: 6px; font-weight: 700;
  color: var(--dsw-alias-brand-primary); }
.nhc-overlay-btn { pointer-events: auto; flex: none; font: inherit; font-size: 10.5px;
  padding: 3px 8px; cursor: pointer; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); }
.nhc-overlay-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.nhc-where { position: absolute; left: 12px; bottom: 6px; font-size: 10.5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.nhc-legend-btn { position: absolute; right: 10px; bottom: 5px; width: 22px; height: 22px;
  font-size: 12px; border-radius: 6px; }
.nhc-legend { position: absolute; right: 10px; bottom: 32px; z-index: 3;
  display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 3px 8px;
  padding: 10px 12px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%); font-size: 11px; color: var(--dsw-alias-label-secondary); }
.nhc-legend code { font: 700 13px ui-monospace, monospace; text-align: center; }
.nhc-map { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.16;
  white-space: pre; user-select: none; overflow: auto; max-width: 100%; max-height: 100%; }
.nhc-map > div { white-space: pre; }
.nhc-g.hero { color: var(--dsw-alias-label-primary); font-weight: 800;
  text-shadow: 0 0 8px color-mix(in srgb, var(--dsw-alias-brand-primary) 70%, transparent); }
.nhc-g.pet { color: var(--dsw-alias-label-primary); font-weight: 700;
  text-decoration: underline; text-underline-offset: 3px;
  text-decoration-color: var(--dsw-alias-state-success-primary); }
.nhc-g.monster { color: var(--dsw-alias-state-error-primary); font-weight: 700; }
.nhc-g.wall { color: var(--dsw-alias-label-secondary); }
.nhc-g.floor { color: var(--dsw-alias-label-tertiary); }
.nhc-g.corridor { color: var(--dsw-alias-label-secondary); opacity: .85; }
.nhc-g.door { color: var(--dsw-alias-state-warn-primary); }
.nhc-g.stairs { color: var(--dsw-alias-state-success-primary); font-weight: 800; }
.nhc-g.gold { color: var(--dsw-alias-state-warn-primary); }
.nhc-g.trap { color: var(--dsw-alias-state-error-primary); }
.nhc-g.potion, .nhc-g.spellbook, .nhc-g.item { color: var(--dsw-alias-brand-primary); }
.nhc-g.weapon, .nhc-g.armor { color: var(--dsw-alias-label-primary); opacity: .85; }
.nhc-g.ring, .nhc-g.amulet { color: var(--dsw-alias-state-success-primary); }
.nhc-g.scroll, .nhc-g.tool, .nhc-g.food { color: var(--dsw-alias-label-secondary); }
.nhc-g.blind { color: var(--dsw-alias-label-tertiary); opacity: .35; }
.nhc-g.other { color: var(--dsw-alias-label-secondary); }
.nhc-blank { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }

/* ---- the pending question, raised over the map ------------------------- */
.nhc-ask { position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%);
  width: min(560px, calc(100% - 24px)); z-index: 4;
  display: flex; flex-direction: column; gap: 8px; padding: 11px 13px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, var(--dsw-alias-border-l2));
  box-shadow: 0 10px 28px rgb(0 0 0 / 22%); }
.nhc-ask h4 { margin: 0; display: flex; align-items: center; gap: 8px; font-size: 10px;
  letter-spacing: .06em; text-transform: uppercase;
  color: var(--dsw-alias-state-warn-primary); font-weight: 600; }
.nhc-ask h4 span { margin-left: auto; font-weight: 400; letter-spacing: 0;
  text-transform: none; color: var(--dsw-alias-label-tertiary); }
.nhc-ask p { margin: 0; font-size: 13px; overflow-wrap: anywhere; }
.nhc-opts { display: flex; flex-wrap: wrap; gap: 6px; }
.nhc-opt { display: inline-flex; align-items: center; gap: 7px; min-height: 28px;
  padding: 0 10px 0 5px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); max-width: 100%; }
.nhc-opt:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.nhc-opt:disabled { opacity: .42; cursor: not-allowed; }
.nhc-opt kbd { min-width: 20px; height: 20px; padding: 0 5px; border-radius: 5px;
  display: inline-grid; place-items: center; font: 700 11px ui-monospace, monospace;
  color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); }
.nhc-opt-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nhc-opt.ghost { color: var(--dsw-alias-label-secondary); }
.nhc-askform { display: flex; gap: 6px; }
.nhc-input { font: inherit; font-size: 12px; flex: 1 1 auto; min-width: 0; height: 28px;
  padding: 0 9px; border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.nhc-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }

/* ---- console: the one always-visible manual control surface ------------ */
.nhc-console { flex: none; display: flex; align-items: stretch; gap: 11px; padding: 9px;
  border-radius: 12px; background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); }
.nhc-console:focus-within { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l1)); }
.nhc-pad { display: grid; grid-template-columns: repeat(3, 28px); grid-auto-rows: 28px; gap: 3px; flex: none; }
.nhc-k { font: inherit; font-size: 12px; display: grid; place-items: center; cursor: pointer;
  border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  transition: transform .05s, background .1s, border-color .1s; }
.nhc-k:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-border-l2); }
.nhc-k:active:not(:disabled) { transform: scale(.94); }
.nhc-k.mid { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.nhc-k:disabled { opacity: .42; cursor: not-allowed; }
.nhc-vsep { width: 1px; flex: none; background: var(--dsw-alias-border-l1); }
.nhc-console-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.nhc-actrow { display: flex; flex-wrap: wrap; gap: 5px; }
.nhc-act { font: inherit; font-size: 11.5px; display: inline-flex; align-items: center; gap: 6px;
  height: 27px; padding: 0 9px 0 5px; border-radius: 7px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); }
.nhc-act:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-border-l2); }
.nhc-act:disabled { opacity: .42; cursor: not-allowed; }
.nhc-act kbd { font: 700 10px ui-monospace, monospace; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-interactive-bg-hover); border-radius: 4px; padding: 1px 5px; }
.nhc-keyline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.nhc-keyline input { flex: 1 1 120px; min-width: 0; height: 27px; padding: 0 9px;
  border-radius: 7px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: 12px ui-monospace, monospace; }
.nhc-keyline input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.nhc-cap { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; flex: none;
  color: var(--dsw-alias-label-tertiary); }
.nhc-cap i { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.nhc-captured .nhc-cap { color: var(--dsw-alias-state-success-primary); }
.nhc-captured .nhc-cap i { background: var(--dsw-alias-state-success-primary); }
.nhc-confirm { flex: none; padding: 7px 9px; border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l2); }
.nhc-confirm p { margin: 0 0 6px; font-size: 12px; }

/* ---- right column: tabs over the conversation and the pack -------------- */
.nhc-side { display: flex; flex-direction: column; min-width: 0;
  border-left: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); }
.nhc-tabs { flex: none; display: flex; gap: 2px; padding: 6px 8px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.nhc-tab { font: inherit; font-size: 11.5px; font-weight: 500; display: flex; align-items: center; gap: 6px;
  padding: 7px 9px 8px; cursor: pointer; border: 0; background: none;
  color: var(--dsw-alias-label-secondary); border-bottom: 2px solid transparent; }
.nhc-tab[aria-selected="true"] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-brand-primary); }
.nhc-tab:hover { color: var(--dsw-alias-label-primary); }
.nhc-tab .nhc-n { font: 10px ui-monospace, monospace; padding: 0 5px; border-radius: 99px;
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.nhc-pane { flex: 1 1 auto; min-height: 0; display: none; flex-direction: column; }
.nhc-pane.on { display: flex; }
.nhc-chat { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0;
  height: 100%; overflow: hidden; }
.nhc-chat > * { min-height: 0; flex: 1 1 auto; }
/* Local overrides only: native blank Views returns null, so explicitly give
   its scroll column the remaining height and push its composer to the floor. */
.nhc-chat [data-conversation-content] { height: 100%; min-height: 0; width: 100%; display: flex; flex-direction: column; }
.nhc-chat [data-conversation-scroll] { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; justify-content: flex-start; }
.nhc-chat [data-composer-seat] { margin-top: auto; flex: 0 0 auto; }
.nhc-transcript-seat { flex: 1 0 auto; min-height: 0; display: flex; flex-direction: column; }
.nhc-chat-blank { display: flex; flex-direction: column; justify-content: center;
  align-items: center; flex: 1 1 auto; min-height: 0; padding: 14px; text-align: center; }
.nhc-pack { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.nhc-pack-head { flex: none; display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; font-size: 10px; font-weight: 600; letter-spacing: .05em;
  text-transform: uppercase; color: var(--dsw-alias-label-secondary);
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.nhc-pack-count { margin-left: auto; font: 400 10px ui-monospace, monospace;
  letter-spacing: 0; opacity: .75; }
/* Exactly one element scrolls here: the pack body. The pack itself clips, so a
   long pack never shows two nested scrollbars. */
.nhc-pack-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
  padding: 6px 8px 12px; }
.nhc-inv { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.nhc-inv-head { margin: 9px 6px 3px; font-size: 9.5px; font-weight: 600; letter-spacing: .05em;
  text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.nhc-inv-head:first-child { margin-top: 3px; }
.nhc-inv-item { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px;
  align-items: center; padding: 4px 6px; border-radius: 7px; }
.nhc-inv-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.nhc-inv-item em { width: 22px; height: 22px; display: grid; place-items: center;
  border-radius: 6px; font: 700 10.5px ui-monospace, monospace; font-style: normal;
  color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); }
.nhc-inv-item span { font-size: 11.5px; line-height: 1.35; overflow-wrap: anywhere; }
.nhc-log { flex: 1; min-height: 0; overflow: auto; margin: 0; padding: 10px 12px;
  list-style: none; display: flex; flex-direction: column; gap: 5px; }
.nhc-log li { font-size: 11.5px; line-height: 1.4; color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere; }
.nhc-log li:first-child { color: var(--dsw-alias-label-primary); }
.nhc-notice { margin: 0; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.nhc-err { margin: 0; font-size: 11.5px; color: var(--dsw-alias-state-error-primary); }
/* A short panel cannot give the stage and the console both their minimums; the
   game column scrolls instead of hiding the composer-sized console. */
@media (max-height: 520px) {
  .nhc-play { overflow: auto; }
  .nhc-stage { min-height: 150px; }
}
`;

    /** Re-render on locale change without depending on a specific React version. */
    function useLocaleRevision(subscribe) {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        if (typeof subscribe !== "function") return undefined;
        return subscribe(() => bump((n) => n + 1));
      }, [subscribe]);
    }

    /**
     * Track an element's content size so the map can be fitted to it.
     *
     * Both axes matter. Width alone was the original mistake: in a short window
     * the map kept its width-derived size and overflowed the column, so the map
     * scrolled instead of shrinking and the composer was pushed out of reach.
     * Falls back to 0 (no fitting) where `ResizeObserver` is unavailable.
     */
    function useElementSize() {
      const ref = React.useRef(null);
      const [size, setSize] = React.useState({ width: 0, height: 0 });
      React.useEffect(() => {
        const node = ref.current;
        if (!node || typeof ResizeObserver !== "function") return undefined;
        const measure = () => setSize({
          width: node.clientWidth || 0,
          height: node.clientHeight || 0,
        });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
      }, []);
      return [ref, size];
    }

    /** Tile bounds of one observation, used to fit the map horizontally. */
    function mapBounds(tiles) {
      if (!Array.isArray(tiles) || tiles.length === 0) return { cols: 80, rows: 24 };
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const tile of tiles) {
        if (tile.x < minX) minX = tile.x;
        if (tile.x > maxX) maxX = tile.x;
        if (tile.y < minY) minY = tile.y;
        if (tile.y > maxY) maxY = tile.y;
      }
      return { cols: maxX - minX + 1, rows: maxY - minY + 1 };
    }

    /**
     * Pick a monospace size that fits `cols` glyphs into `width` pixels.
     *
     * A monospace glyph is about 0.6em wide; the constant is deliberately a
     * little generous so the map never develops a horizontal scrollbar. The
     * result is clamped to a readable range, and the map scrolls beyond that.
     */
    function fitFontSize(width, cols, height = 0, rows = 0) {
      if (!width || width <= 0) return 11;
      const usable = width - 26;
      const byWidth = usable / Math.max(cols, 1) / 0.62;
      // A line box is 1.18em, so this is the size at which `rows` lines still fit
      // the column. Ignoring it meant a short window scrolled the map off-screen.
      const byHeight = height > 0 && rows > 0
        ? (height - 26) / Math.max(rows, 1) / 1.18
        : Infinity;
      const per = Math.min(byWidth, byHeight);
      return Math.max(5, Math.min(13.5, Math.round(per * 10) / 10));
    }

    /**
     * Map one engine inventory header ("Weapons", "Coins") to a locale key.
     *
     * The engine emits these headings in English; showing them untranslated in a
     * Chinese panel is the main reason the pack reads as gibberish. Unknown
     * headings fall through unchanged so a new engine class is never hidden.
     */
    const INV_HEADERS = {
      coins: "invCoins", weapons: "invWeapons", armor: "invArmor",
      comestibles: "invComestibles", spellbooks: "invSpellbooks",
      potions: "invPotions", wands: "invWands", rings: "invRings",
      amulets: "invAmulets", scrolls: "invScrolls", gems: "invGems",
      books: "invBooks", tools: "invTools", other: "invOther",
    };

    /**
     * Render one carried row in the reader's language.
     *
     * NetHack's own row text ("a blessed +0 scalpel (weapon in hand)") is dense
     * jargon: it stays as the fallback, but the known heading and the trailing
     * state note are translated so the list scans as a list of things.
     */
    function inventoryLabel(item, t) {
      const text = String(item?.text ?? "");
      const key = INV_HEADERS[text.trim().toLowerCase().replace(/:$/, "")];
      if (key) return t(key);
      let label = text;
      const states = [
        [" (weapon in hand)", "invWielded"],
        [" (being worn)", "invWorn"],
        [" (alternate weapon; not wielded)", "invAlternate"],
      ];
      for (const [suffix, stateKey] of states) {
        if (label.endsWith(suffix)) {
          label = `${label.slice(0, -suffix.length)} ${t(stateKey)}`;
          break;
        }
      }
      return label;
    }

    /**
     * Draw the tile set as coloured monospace rows.
     *
     * The pet is drawn apart from other monsters: it is friendly, follows the
     * player and only `observe`'s neighbour line says which glyph it is, so the
     * panel passes that glyph down instead of colouring every `d` as hostile.
     */
    function renderMap(tiles, t, fontPx, petGlyph) {
      if (!Array.isArray(tiles) || tiles.length === 0) {
        return h("div", { className: "nhc-map", style: { fontSize: "11px" } }, t("emptyMap"));
      }
      const xs = tiles.map((tile) => tile.x);
      const ys = tiles.map((tile) => tile.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const at = new Map(tiles.map((tile) => [`${tile.x},${tile.y}`, tile]));
      const rows = [];
      for (let y = minY; y <= maxY; y++) {
        const cells = [];
        for (let x = minX; x <= maxX; x++) {
          const glyph = at.get(`${x},${y}`)?.text;
          if (!glyph || glyph === " ") { cells.push(" "); continue; }
          let kind = GLYPH_CLASS[glyph] ?? (MONSTER_LETTER.test(glyph) ? "monster" : "other");
          // Only letters can be creatures, so the pet glyph never recolours
          // terrain or items that happen to share it ('.' is floor, not code).
          if (petGlyph && glyph === petGlyph && MONSTER_LETTER.test(glyph)) kind = "pet";
          cells.push(h("span", { key: x, className: `nhc-g ${kind}` }, glyph));
        }
        rows.push(h("div", { key: y }, cells));
      }
      return h("div", { className: "nhc-map", style: { fontSize: `${fontPx}px` } }, rows);
    }

    /**
     * Board presentation, kept as small components so the panel body stays about
     * flow control: these only draw what the state route already returned.
     */

    /** Numeric status, tolerant of the engine's strings. */
    function numberOf(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }

    /**
     * The HUD: who and where, HP and Pw as bars, the quiet facts, conditions.
     *
     * The status used to be a row of bare numbers under the map. Bars answer the
     * one question the person actually has while watching the game ("am I about
     * to die?"), so HP and Pw get width; gold, turn and strength stay as plain
     * figures because they are read, not compared.
     */
    function StatusBar(props) {
      const { t, state, onRefresh, onRestart } = props;
      const status = state?.status ?? {};
      const conditions = Array.isArray(state?.conditions) ? state.conditions : [];
      const hp = numberOf(status.BL_HP);
      const hpMax = numberOf(status.BL_HPMAX);
      const pw = numberOf(status.BL_PW);
      const pwMax = numberOf(status.BL_PWMAX);
      const gold = numberOf(status.BL_GOLD);
      const ac = numberOf(status.BL_AC);
      const str = status.BL_STR ? String(status.BL_STR) : null;
      const level = status.BL_LEVEL ? String(status.BL_LEVEL) : null;
      const depth = status.BL_LEVELDESC ? String(status.BL_LEVELDESC) : null;
      const where = [level ? `${t("lvl")} ${level}` : null, depth].filter(Boolean).join(" · ");
      const hpRatio = hp !== null && hpMax ? hp / hpMax : null;
      const hpTone = hpRatio === null ? "" : hpRatio <= 0.25 ? " low" : hpRatio <= 0.5 ? " mid" : "";
      const pwRatio = pw !== null && pwMax ? pw / pwMax : null;
      const facts = [
        [t("ac"), ac], [t("gold"), gold], [t("turn"), numberOf(state?.turn)], [t("str"), str],
      ].filter(([, value]) => value !== null && value !== undefined && value !== "");
      const critical = /confus|stun|blind|hallu|overload|burden|slow|恶|混乱|致盲/i.test(conditions.join(" "));
      return h("header", { className: "nhc-hud" },
        h("div", { className: "nhc-who" },
          h("i", { className: "nhc-avatar", "aria-hidden": true }, "@"),
          h("div", null,
            h("b", null, status.BL_TITLE || t("panel")),
            where ? h("span", null, where) : null)),
        hp !== null || pw !== null
          ? h("div", { className: "nhc-bars" },
              hp !== null
                ? h("div", { className: `nhc-bar hp${hpTone}`, title: `${t("hp")} ${hp}${hpMax ? `/${hpMax}` : ""}` },
                    h("span", null, "HP"),
                    h("div", { className: "nhc-bar-track" },
                      h("div", { className: "nhc-bar-fill", style: { width: `${Math.round((hpRatio ?? 1) * 100)}%` } })),
                    h("em", null, hpMax ? `${hp}/${hpMax}` : String(hp)))
                : null,
              pw !== null && pwMax
                ? h("div", { className: "nhc-bar pw", title: `${t("pw")} ${pw}/${pwMax}` },
                    h("span", null, "Pw"),
                    h("div", { className: "nhc-bar-track" },
                      h("div", { className: "nhc-bar-fill", style: { width: `${Math.round((pwRatio ?? 0) * 100)}%` } })),
                    h("em", null, `${pw}/${pwMax}`))
                : null)
          : null,
        facts.length
          ? h("div", { className: "nhc-stats" },
              ...facts.map(([key, value], index) => h("div", {
                className: `nhc-stat${index > 0 && key === t("turn") ? " nhc-stat-extra" : ""}`, key,
              },
                h("b", null, String(value)),
                h("span", null, key))))
          : null,
        h("div", { className: "nhc-conds", "aria-label": t("status") },
          conditions.map((text) => h("span", {
            className: `nhc-cond${critical ? " bad" : ""}`, key: text,
          }, text))),
        h("div", { className: "nhc-hud-actions" },
          // New game lives in the HUD so a finished or stuck game has an obvious
          // way out; the confirmation still lives in the console below.
          typeof onRestart === "function"
            ? h("button", { type: "button", className: "nhc-ib", title: t("restart"), "aria-label": t("restart"), onClick: onRestart }, "⟲")
            : null,
          h("button", {
            type: "button", className: "nhc-ib", title: t("refresh"), "aria-label": t("refresh"),
            onClick: onRefresh,
          }, "↻")),
      );
    }

    /** The map key, opened from the stage's "?" corner. */
    function MapLegend(props) {
      const { t } = props;
      const rows = [
        ["@", "legendHero"], ["d", "legendPet"], ["d", "legendMonster"],
        [".", "legendFloor"], ["#", "legendCorridor"], ["|", "legendWall"],
        ["+", "legendDoor"], [">", "legendStairs"], ["^", "legendTrap"],
        ["%", "legendItem"], ["░", "legendBlind"],
      ];
      return h("div", { className: "nhc-legend", role: "note", "aria-label": t("legend") },
        ...rows.flatMap(([glyph, key]) => [
          h("code", { key: `${key}-g`, className: `nhc-g ${GLYPH_CLASS[glyph] ?? "other"}` }, glyph),
          h("span", { key: `${key}-t` }, t(key)),
        ]));
    }

    /**
     * The stage: the map, the engine's last lines over it, the question raised
     * over it, and the position/legend corners.
     *
     * Both axes are measured: sizing by width alone overflowed the column in a
     * short window and scrolled the map instead of shrinking it. The overlay and
     * the question are absolutely positioned so neither changes the map's height
     * when a message arrives or a prompt appears.
     */
    function MapView(props) {
      const { t, map, player, messages, petGlyph, onMessages, question, reply, setReply, busy, onAnswer } = props;
      const [ref, size] = useElementSize();
      const [legend, setLegend] = React.useState(false);
      const tiles = Array.isArray(map) ? map : [];
      const bounds = mapBounds(tiles);
      const fontPx = fitFontSize(size.width - 20, bounds.cols, size.height - 58, bounds.rows);
      const lines = Array.isArray(messages) ? messages.slice(-3) : [];
      const depth = props.depth ? String(props.depth) : "";
      const where = player
        ? `${depth ? `${depth} · ` : ""}@ ${player.x},${player.y}`
        : depth;
      return h("div", { className: "nhc-stage", ref },
        lines.length
          ? h("div", { className: "nhc-overlay" },
              h("div", { className: "nhc-overlay-log" },
                ...lines.map((text, index) => h("p", { key: `${index}-${text}`, title: text }, text))),
              h("button", { type: "button", className: "nhc-overlay-btn", onClick: onMessages },
                `${t("seeAllMessages")} · ${messages.length}`))
          : null,
        tiles.length
          ? renderMap(tiles, t, fontPx, petGlyph)
          : h("p", { className: "nhc-blank" }, t("emptyMap")),
        where ? h("div", { className: "nhc-where" }, where) : null,
        h("button", {
          type: "button", className: "nhc-ib nhc-legend-btn", title: t("legendBtn"),
          "aria-label": t("legendBtn"), "aria-expanded": legend,
          onClick: () => setLegend((open) => !open),
        }, "?"),
        legend ? h(MapLegend, { t }) : null,
        question
          ? h(AskBar, { t, question, reply, setReply, busy, onAnswer })
          : null,
      );
    }

    /**
     * Whatever the engine is asking, raised over the map.
     *
     * Menu rows become buttons carrying their OWN accelerator, so a person can
     * answer without knowing which letter the engine accepts. The text field
     * stays for everything that cannot be listed (a line prompt, a direction
     * key, a name).
     */
    function AskBar(props) {
      const { t, question, reply, setReply, busy, onAnswer } = props;
      const options = menuOptions(question);
      const waiting = question.waiting_for;
      const key = (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onAnswer();
      };
      // A free-text field only makes sense where the answer is typed: a line
      // prompt, a menu with no selectable row, or a "key" prompt. --More--,
      // directions and yes/no are answered by a button or the pad, so showing a
      // text box there just adds a wrong way to answer.
      // A yes/no question keeps the field because the engine also accepts a
      // word here, and a wrong guess is cheaper to type than to discover.
      const wantsText = waiting === "line" || waiting === "key" || waiting === "yn"
        || (waiting !== "more" && waiting !== "direction" && options.length === 0);
      const shortcuts = waiting === "more"
        ? [{ key: " ", label: t("continueAction") }]
        : waiting === "yn"
          ? [{ key: "y", label: "y" }, { key: "n", label: "n" }]
          : [];
      return h("div", { className: "nhc-ask", role: "group", "aria-label": t("asking") },
        h("h4", null, t("asking"), h("span", null, t("escapeAction"))),
        h("p", null, promptText(question, t)),
        shortcuts.length || options.length
          ? h("div", { className: "nhc-opts" },
              ...shortcuts.map((option) => h("button", {
                key: option.key, type: "button", className: "nhc-opt", disabled: busy,
                onClick: () => onAnswer(option.key),
              }, h("kbd", null, option.key === " " ? "␣" : option.key), h("span", { className: "nhc-opt-label" }, option.label))),
              ...options.slice(0, 12).map((option) => h("button", {
                key: option.key, type: "button", className: "nhc-opt", disabled: busy,
                title: option.label, onClick: () => onAnswer(option.key),
              }, h("kbd", null, option.key), h("span", { className: "nhc-opt-label" }, option.label))))
          : null,
        wantsText
          ? h("form", {
              className: "nhc-askform",
              onSubmit: (event) => { event.preventDefault(); onAnswer(); },
            },
              h("input", {
                className: "nhc-input", value: reply, placeholder: t("reply"),
                disabled: busy, spellCheck: false,
                onChange: (event) => setReply(event.target.value), onKeyDown: key,
              }),
              h("button", { type: "submit", className: "nhc-btn", disabled: busy }, t("answer")))
          : null,
      );
    }

    /** The game's conversation: a real DSH session, rendered by DSH's own chat.
     *
     * The panel used to draw its own transcript and post to a private Host route
     * that ran a private tool loop. That meant two chat implementations and every
     * harness feature -- streaming, stop, the model picker, compaction,
     * persistence -- built twice. Now the panel creates an ordinary session with
     * the `nethack` agent preset, tells the Host to attach the game's tools to
     * it, and binds the shipped Conversation to that session. This component
     * only decides WHICH session that is and waits for it to be ready.
     *
     * A new game (`nethack_restart` mints a new game id) gets a new session, so
     * one game's transcript never continues into the next.
     */
    /**
     * The game's conversation: a real DSH session, rendered by DSH's own chat.
     *
     * The panel used to draw its own transcript and post to a private Host route
     * that ran a private tool loop. That meant two chat implementations and every
     * harness feature -- streaming, stop, the model picker, compaction,
     * persistence -- built twice. Now the panel creates an ordinary session with
     * the `nethack` agent preset, tells the Host to attach the game's tools to
     * it, and binds the shipped Conversation to that session. This component
     * only decides WHICH session that is and waits for it to be ready.
     *
     * A new game (`nethack_restart` mints a new game id) gets a new session, so
     * one game's transcript never continues into the next.
     */
    // Identity outlives a panel mount. Only a NEW game id gets a new Session.
    // Cache promises as well as ids so StrictMode/parallel panel mounts cannot
    // mint duplicate conversations while create() is still pending.
    const gameSessions = window[Symbol.for("dsh-nethack.client-sessions.v1")] ??= new Map();
    function sessionForGame(sessions, gameId) {
      let pending = gameSessions.get(gameId);
      if (!pending) {
        pending = (async () => {
          const response = await fetch(`${ROUTE_SESSION}?game_id=${encodeURIComponent(gameId)}`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const saved = await response.json();
          return saved.session_id ?? await sessions.create({ agentPreset: GAME_PRESET });
        })();
        gameSessions.set(gameId, pending);
        pending.catch(() => { if (gameSessions.get(gameId) === pending) gameSessions.delete(gameId); });
      }
      return pending;
    }

    function GameChat(props) {
      const t = props.t;
      const gameId = props.gameId;
      const sessions = props.sessions;
      const [state, setState] = React.useState({ phase: "creating" });

      React.useEffect(() => {
        // Wait for the engine identity: otherwise initial loading creates a
        // throwaway session, then creates another when the first poll finishes.
        if (!gameId) return undefined;
        if (typeof sessions?.create !== "function" || typeof sessions?.retain !== "function") {
          setState({ phase: "error", error: "DSH session creation is unavailable" });
          return undefined;
        }
        const controller = new AbortController();
        let reference;
        const release = () => {
          const owned = reference;
          reference = undefined;
          owned?.release();
        };
        setState({ phase: "creating" });
        (async () => {
          try {
            // Public ClientSessions.create returns an id and catalogs it before
            // resolving. Omit sessionId so the Host mints a NEW session; never
            // use workspace navigation, which may adopt the user's blank chat.
            const sessionId = await sessionForGame(sessions, gameId);
            if (controller.signal.aborted) return;
            setState({ phase: "attaching", sessionId });
            reference = sessions.retain(sessionId, { source: "nethackChat", signal: controller.signal });
            await reference.ready;
            if (controller.signal.aborted) return;
            const response = await fetch(ROUTE_SESSION, {
              method: "POST",
              signal: controller.signal,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ session_id: sessionId, game_id: gameId }),
            });
            const body = await response.json();
            if (controller.signal.aborted) return;
            if (!response.ok) throw new Error([body?.error ?? `HTTP ${response.status}`, body?.detail].filter(Boolean).join(": "));
            const tools = body?.tools;
            if (!Array.isArray(tools) || tools.length !== 3
              || !["nethack_observe", "nethack_act", "nethack_respond"].every(name => tools.includes(name))) {
              throw new Error("Game session tool isolation failed");
            }
            // Do not archive: DSH's archived-session gate blocks model steps.
            setState({ phase: "ready", sessionId, gameId, reference, tools });
          } catch (cause) {
            release();
            if (!controller.signal.aborted) setState({ phase: "error", error: String(cause?.message ?? cause) });
          }
        })();
        return () => { controller.abort(); release(); };
      }, [sessions, gameId]);

      if (state.phase !== "ready" || state.gameId !== gameId) {
        return h("div", { className: "nhc-chat-blank" },
          h("p", { className: "nhc-notice" },
            state.phase === "error"
              ? `${t("chatFailed")}: ${state.error}`
              : state.phase === "attaching" ? t("chatAttaching") : t("chatStarting")));
      }

      // The reference is handed DOWN to the child slot, not consumed here: the
      // child holds the Session and renders the Conversation, exactly as the
      // shipped subagent sidebar chat does. `GameChat` only decides WHICH
      // session; the seat decides how it is displayed.
      return h(props.SessionProvider, {
        session: state.reference,
        children: h("div", { className: "nhc-chat", "data-nh-tools": (state.tools ?? []).join(" ") },
          props.renderSlot(CONV_SLOT, { reference: state.reference }),
        ),
      });
    }

    /**
     * The game's conversation body: the shipped Conversation, embedded.
     *
     * This runs inside the provider `GameChat` bound to the GAME's session, so
     * the Conversation below resolves its session from context and every part
     * of the shipped chat -- transcript, composer, streaming, stop, the model
     * picker -- applies to the game with no code here.
     *
     * The renderer supplies renderFactorySlot to every entry. This child slot
     * is needed for its explicit GAME session binding, not for factory access.
     */
    function ConversationBody(props) {
      // GameChat owns the reference; this child only borrows its binding.
      const { renderFactorySlot } = props;
      return renderFactorySlot("conversation.content", {
        variant: "embedded",
        phase: "active",
        hero: false,
      }, { slots: { views: FixedChatConversationView } });
    }

    /** Fixed Chat selection used by an embedded Conversation occurrence. */
    function FixedChatConversationView(props) {
      return h("div", { className: "nhc-transcript-seat" }, props.renderSlot("conversation.session", { view: "chat" }));
    }

    /**
     * The console: the one always-visible manual control surface.
     *
     * The old manual was a bordered box in a side column, with the direction pad
     * and the action buttons stacked under it. Here it is one strip under the
     * stage: pad, then the verbs, then the free-key field, so a hand-play turn is
     * "click, click" without hunting through a panel. Keys are only captured
     * while this strip has focus (its own onKeyDown), so typing into the chat
     * composer beside it is never eaten.
     */
    function GameControls({ t, state, busy, send }) {
      const [reply, setReply] = React.useState("");
      // Whether this strip has the keyboard. Only while focused does the pad
      // answer arrow keys, so the chat composer beside it keeps working; the
      // label says which mode the person is in instead of leaving them to guess
      // why the arrows sometimes walk and sometimes type.
      const [focused, setFocused] = React.useState(false);
      const command = state?.waiting_for === "command";
      const ended = !!state?.ended;
      const locked = busy || ended;
      const input = key => send(command ? { action: "raw_keys", keys: key } : { kind: "respond", reply: key });
      // The verbs are keystrokes, so they need the command prompt; the pad and
      // the free-key field work anywhere, because they answer whatever prompt
      // the engine is on (a direction question takes 8/2/4/6 too).
      const act = (label, glyph, key, enabled) => h("button", {
        key: label, type: "button", className: "nhc-act", disabled: locked || !enabled,
        onClick: () => send({ action: key }),
      }, h("kbd", null, glyph), t(label));
      const dirs = [["↖", "7"], ["↑", "8"], ["↗", "9"], ["←", "4"], ["·", "."], ["→", "6"], ["↙", "1"], ["↓", "2"], ["↘", "3"]];
      return h("div", {
        className: `nhc-console${focused ? " nhc-captured" : ""}`, tabIndex: 0,
        role: "group", "aria-label": t("keys"),
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onKeyDown: event => {
          if (locked || /^(INPUT|TEXTAREA|BUTTON)$/.test(event.target?.tagName) || event.target?.isContentEditable
            || event.ctrlKey || event.metaKey || event.altKey) return;
          const mapped = { ArrowUp: "8", ArrowDown: "2", ArrowLeft: "4", ArrowRight: "6", Escape: "\u001b", Enter: "\n" };
          const key = mapped[event.key] ?? (event.key?.length === 1 ? event.key : null);
          if (key !== null) { event.preventDefault(); input(key); }
        },
      },
        h("div", { className: "nhc-pad" },
          ...dirs.map(([label, key]) => h("button", {
            key, type: "button", className: `nhc-k${key === "." ? " mid" : ""}`,
            disabled: locked, "aria-label": `${label} (${key})`, title: key,
            onClick: () => input(key),
          }, label))),
        h("div", { className: "nhc-vsep" }),
        h("div", { className: "nhc-console-main" },
          h("div", { className: "nhc-actrow" },
            h("button", {
              key: "wait", type: "button", className: "nhc-act", disabled: locked || !command,
              onClick: () => send({ action: "wait" }),
            }, h("kbd", null, "."), t("waitAction")),
            act("actSearch", "s", "search", command),
            act("actPickup", ",", "pickup", command),
            act("actOpen", "o", "open", command),
            act("actDescend", ">", "descend", command),
            act("actAscend", "<", "ascend", command)),
          h("div", { className: "nhc-keyline" },
            h("form", {
              key: "freekey",
              onSubmit: event => {
                event.preventDefault();
                const answer = String(reply ?? "").trim();
                if (!locked && answer) { input(answer); setReply(""); }
              },
            },
              h("input", {
                type: "text", value: reply, "aria-label": t("keyReply"), placeholder: t("keyReply"),
                disabled: locked, spellCheck: false, autoComplete: "off",
                onChange: event => setReply(event.target.value),
              })),
            h("button", {
              key: "space", type: "button", className: "nhc-act", disabled: locked,
              onClick: () => input(" "),
            }, h("kbd", null, "␣"), t("continueAction")),
            h("button", {
              key: "enter", type: "button", className: "nhc-act", disabled: locked,
              onClick: () => input("\n"),
            }, h("kbd", null, "⏎"), t("enterAction")),
            h("button", {
              key: "esc", type: "button", className: "nhc-act", disabled: locked,
              onClick: () => input("\u001b"),
            }, h("kbd", null, "Esc"), t("escapeAction")),
            h("span", { key: "cap", className: "nhc-cap", title: t("manualHint") },
              h("i", { "aria-hidden": true }), focused ? t("captured") : t("notCaptured")))),
      );
    }

    /** One sidebar tab button, shared by all three panes. */
    function TabButton(props) {
      const { id, active, onSelect, children } = props;
      return h("button", {
        type: "button", className: "nhc-tab", role: "tab",
        "aria-selected": active, onClick: () => onSelect(id),
      }, children);
    }

    /**
     * The panel body, rendered by a `session` child slot.
     *
     * The panel shows a conversation, and DSH's Conversation reads the session
     * from a React context that only a `session` slot provides. So the panel is
     * registered inside `PANEL_SLOT` (a `session` child of `main` /
     * `sidebar.right.pane.tab`) and receives the slot system's `SessionProvider`.
     *
     * The layout is two columns: the game (HUD, stage, console) on the left and
     * the GAME's conversation on the right, with the pack and the message log as
     * sibling tabs there. That conversation is an ordinary DSH session with the
     * `nethack` agent preset: the panel tells the Host to attach the game tools
     * to it and binds `SessionProvider` to that session, so streaming, stop, the
     * model picker, compaction and persistence all apply with no second chat
     * implementation living in this file.
     *
     * Isolation is enforced by the Host, not here: the three nethack_* tools are
     * registered into that session's agent scope only and the agent is
     * restricted to them, so the person's own conversation never sees the game
     * tools and this session cannot reach the workspace.
     */
    function NetHackPanel(props) {
      const t = props.t;
      useLocaleRevision(props.subscribeLocale);

      const usePanelInfo = props.usePanelInfo;
      const selected = typeof usePanelInfo === "function" ? usePanelInfo((info) => info?.activePanelId) : null;
      const useTabInfo = props.useTabInfo;
      const tabInfo = typeof useTabInfo === "function" ? useTabInfo() : null;
      // Right tabs also receive usePanelInfo, but that describes the CENTRE.
      // Using it there skipped every request while the centre showed chat.
      // Hook availability is fixed by the slot hosting this component.
      const panelVisible = typeof useTabInfo === "function"
        ? tabInfo?.tab?.visible === true
        : typeof usePanelInfo !== "function" || selected === PANEL_ID;
      const [state, setState] = React.useState(null);
      const [reply, setReply] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [tab, setTab] = React.useState("chat");
      const [confirming, setConfirming] = React.useState(false);
      const alive = React.useRef(true);

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(ROUTE_STATE);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const next = await response.json();
          if (alive.current) { setState(next); setError(null); }
        } catch (cause) {
          if (alive.current) setError(String(cause?.message ?? cause));
        }
      }, []);

      // Only a visible panel polls. A panel that is neither the selected `main`
      // body nor the open right-column tab is still mounted (and would otherwise
      // poll forever behind another view), so it has to be told to stand down.
      //
      // The first poll is immediate and the rest follow the timer. A background
      // window is not a stopped game, it just needs less traffic, so it polls on
      // the hidden cadence and catches up on the visibility event.
      React.useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);
      React.useEffect(() => {
        if (!panelVisible) return undefined;
        let timer;
        // `hidden` is the modern flag; `visibilityState` is the older one. Read
        // both so a browser (or a test double) that only reports one still works.
        const hidden = () => typeof document !== "undefined"
          && (document.hidden === true || document.visibilityState === "hidden");
        const tick = () => {
          if (!alive.current || hidden()) return;
          clearTimeout(timer);
          Promise.resolve(load()).finally(() => {
            if (alive.current) timer = setTimeout(tick, POLL_VISIBLE_MS);
          });
        };
        const poll = () => {
          if (!alive.current) return;
          if (hidden()) { timer = setTimeout(poll, POLL_HIDDEN_MS); return; }
          tick();
        };
        poll();
        const onVisible = () => { if (!hidden()) tick(); };
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
        return () => {
          clearTimeout(timer);
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
        };
      }, [load, panelVisible]);

      const send = React.useCallback(async (body) => {
        setBusy(true);
        try {
          const response = await fetch(ROUTE_ACTION, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const next = await response.json().catch(() => null);
          if (!response.ok) setError(next?.error ?? `HTTP ${response.status}`);
          else { setState(next); setError(null); setReply(""); }
        } catch (cause) {
          setError(String(cause?.message ?? cause));
        } finally {
          setBusy(false);
        }
      }, []);

      const restart = React.useCallback(async () => {
        setConfirming(false);
        await send({ action: "restart" });
      }, [send]);

      // Rendered in every branch: talking to the model is useful even while the
      // engine is still starting or momentarily unreachable. The game id is what
      // separates one game's conversation from the next (`nethack_restart` mints
      // a new one); `GameChat` reacts to that change itself.
      const gameId = state?.game_id;
      const chat = h(GameChat, {
        t,
        gameId,
        sessions: props.sessions,
        SessionProvider: props.SessionProvider,
        renderSlot: props.renderSlot,
      });

      const messages = recentMessages(state);
      const question = state && !state.ended && state.waiting_for !== "command" && state.waiting_for !== "ended"
        ? state : null;

      // The side column: the conversation, the pack and the log, one at a time.
      // `aria-controls`/`role` are advisory only -- the panes are plain divs --
      // but they make the switching findable by a screen reader.
      const side = h("aside", { className: "nhc-side" },
        h("div", { className: "nhc-tabs", role: "tablist" },
          h(TabButton, { id: "chat", active: tab === "chat", onSelect: setTab }, t("tabChat")),
          h(TabButton, { id: "pack", active: tab === "pack", onSelect: setTab },
            t("tabPack"),
            Array.isArray(state?.inventory) && state.inventory.length
              ? h("span", { className: "nhc-n" }, String(state.inventory.filter((item) => !item.header).length))
              : null),
          h(TabButton, { id: "log", active: tab === "log", onSelect: setTab },
            t("tabLog"),
            messages.length ? h("span", { className: "nhc-n" }, String(state?.messages?.length ?? messages.length)) : null)),
        h("div", { className: `nhc-pane${tab === "chat" ? " on" : ""}`, role: "tabpanel", "data-pane": "chat" }, chat),
        tab === "pack"
          ? h("div", { className: "nhc-pane on", role: "tabpanel", "data-pane": "pack" },
              h(PackPanel, { t, state }))
          : null,
        tab === "log"
          ? h("div", { className: "nhc-pane on", role: "tabpanel", "data-pane": "log" },
              h(MessageLog, { t, messages }))
          : null,
      );

      const stage = state && !state.ended
        ? h(MapView, {
            t,
            map: state.tiles,
            player: state.player,
            messages,
            petGlyph: petGlyphOf(state),
            depth: state.status?.BL_LEVELDESC,
            onMessages: () => setTab("log"),
            question,
            reply,
            setReply,
            busy,
            onAnswer: (answer) => send({ kind: "respond", reply: answer ?? reply }),
          })
        : h("div", { className: "nhc-stage" },
            h("p", { className: "nhc-blank" },
              !state
                ? (error ? `${t("unreachable")}: ${error}` : t("loading"))
                : t("gameOver")));

      const body = h("div", {
        className: "nhc-body", "data-placement": props.placement,
      },
        state && !state.ended
          ? h(StatusBar, { t, state, onRefresh: load, onRestart: () => setConfirming(true) })
          : h("header", { className: "nhc-hud" },
              h("div", { className: "nhc-who" },
                h("i", { className: "nhc-avatar", "aria-hidden": true }, "@"),
                h("div", null,
                  h("b", null, t("panel")),
                  h("span", null, !state
                    ? (error ? t("unreachable") : t("loading"))
                    : t("gameOver")))),
              h("div", { className: "nhc-hud-actions" },
                h("button", {
                  type: "button", className: "nhc-ib", title: t("refresh"),
                  "aria-label": t("refresh"), onClick: load,
                }, "↻"),
                state
                  ? h("button", {
                      type: "button", className: "nhc-ib", title: t("restart"),
                      "aria-label": t("restart"), onClick: () => setConfirming(true),
                    }, "⟲")
                  : null)),
        h("main", { className: "nhc-play" },
          // Asked in the game column, right under the HUD that triggered it.
          confirming
            ? h("div", { className: "nhc-confirm", role: "alert" },
                h("p", null, t("restartConfirm")),
                h("div", { className: "nhc-actrow" },
                  h("button", { type: "button", className: "nhc-btn", onClick: restart }, t("confirmRestart")),
                  h("button", { type: "button", className: "nhc-btn", onClick: () => setConfirming(false) }, t("cancel"))))
            : null,
          stage,
          error && state ? h("p", { className: "nhc-err" }, error) : null,
          h(GameControls, { t, state, busy, send })),
        side,
      );

      return h("div", { className: "nhc-root", "data-placement": props.placement }, body);
    }

    /**
     * The neighbouring pet, read from the map.
     *
     * A `d` you own and a `d` that wants to eat you look identical on the map,
     * so colouring every letter red would call the follower an enemy. The tiles
     * carry no pet flag -- `observe`'s neighbour prose does, but this panel only
     * receives the state route's tiles -- so this is the honest heuristic: a
     * letter next to the `@` that is one of the starting pets (dog, cat, pony,
     * and the grown forms they become). The legend says "your pet" for a
     * lettered glyph rather than the map claiming a certainty it lacks.
     */
    const PET_GLYPHS = new Set("dfuDFU".split(""));
    function petGlyphOf(state) {
      const player = state?.player;
      const tiles = Array.isArray(state?.tiles) ? state.tiles : [];
      if (!player) return null;
      for (const tile of tiles) {
        const dx = Math.abs((tile.x ?? 0) - player.x);
        const dy = Math.abs((tile.y ?? 0) - player.y);
        if (dx <= 1 && dy <= 1 && (dx || dy) && PET_GLYPHS.has(tile.text)) return tile.text;
      }
      return null;
    }

    /** The engine's last lines, newest last, trimmed to what fits over the map. */
    function recentMessages(state) {
      const messages = Array.isArray(state?.messages) ? state.messages : [];
      // The opening narrative is noise once play has started; keep the tail.
      return messages.slice(-3);
    }

    /**
     * The engine's message history, for the side column's log tab.
     *
     * The stage already shows the last few lines over the map; this is where the
     * whole buffer lives, newest first, because the engine only keeps a window
     * and a person asking "what just hit me" wants more than three lines.
     */
    function MessageLog(props) {
      const { t, messages } = props;
      const lines = Array.isArray(messages) ? messages.slice(-14).reverse() : [];
      return h(React.Fragment, null,
        h("div", { className: "nhc-pack-head" }, h("span", null, t("messages")),
          lines.length ? h("span", { className: "nhc-pack-count" }, String(lines.length)) : null),
        h("ul", { className: "nhc-log" },
          ...(lines.length
            ? lines.map((text, index) => h("li", { key: `${index}-${text}` }, text))
            : [h("li", { key: "empty" }, t("noMessages"))])));
    }

    /**
     * The pack, in the narrow left column beside the chat.
     *
     * Same data the old drawer showed, laid out to be read at a glance: category
     * headings stay, the selection letter is pulled out into its own column so the
     * item names line up, and the held/worn note is kept because it changes what an
     * action does. Scrolls internally: a long pack must never push the composer
     * out of the panel. Exactly ONE element scrolls here (`.nhc-pack-body`); the
     * column wrapper clips, so the pack never shows two nested scrollbars.
     */
    function PackPanel(props) {
      const { state, t } = props;
      const items = Array.isArray(state?.inventory) ? state.inventory : [];
      return h("div", { className: "nhc-pack" },
        h("div", { className: "nhc-pack-head" },
          h("span", null, t("inventory")),
          items.length ? h("span", { className: "nhc-pack-count" }, String(items.length)) : null,
        ),
        h("div", { className: "nhc-pack-body" },
          items.length
            ? h("ul", { className: "nhc-inv" },
                ...items.map((item, index) => h("li", {
                  key: `${index}-${item.text}`,
                  className: item.header ? "nhc-inv-head" : "nhc-inv-item",
                },
                  item.header
                    ? inventoryLabel(item, t)
                    : h(React.Fragment, null,
                        h("em", null, item.letter ?? ""),
                        h("span", null, inventoryLabel(item, t))),
                )))
            : h("p", { className: "nhc-notice" }, t("noInventory")),
        ),
      );
    }

    /**
     * The sidebar entry: the player's `@`, as a button that opens the right column.
     *
     * The panel list renders each entry inside its own control and dispatches the
     * entry id to the `main` slot. To open the right column instead, the icon
     * carries its own click handler and stops the event so the list does not also
     * swap the centre panel -- otherwise one click would do both.
     */
    function NethackIcon(props) {
      const size = typeof props?.size === "number" && props.size > 0 ? props.size : 18;
      return h("svg", {
        viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": true,
        style: { display: "block", flex: "none" },
      },
        h("text", {
          x: 12, y: 17, textAnchor: "middle",
          fontSize: 15, fontWeight: 600,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fill: "currentColor",
        }, "@"),
      );
    }

    function promptText(state, t) {
      const prompt = state.prompt ?? {};
      if (prompt.question) return prompt.question;
      if (prompt.title) return prompt.title;
      if (state.waiting_for === "more") return t("more");
      if (state.waiting_for === "yn") return t("yn");
      if (state.waiting_for === "line") return t("line");
      if (state.waiting_for === "menu") return t("menu");
      if (state.waiting_for === "position") return t("position");
      return t("waiting");
    }

    /**
     * Selectable menu rows, as `{key, label}`.
     *
     * `accelerator` is the key the engine accepts for a row; headers (identifier
     * 0) and rows without an accelerator are not selectable and are dropped, so
     * the panel only offers answers that will actually be accepted.
     */
    function menuOptions(state) {
      const items = state.prompt?.items;
      if (!Array.isArray(items)) return [];
      return items
        .filter((item) => item && item.identifier !== 0)
        .map((item) => {
          const acc = Number(item.accelerator);
          const key = Number.isFinite(acc) && acc > 32 && acc < 127 ? String.fromCharCode(acc) : "";
          return { key, label: item.text || key };
        })
        .filter((item) => item.key);
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        const t = ctx.locale.bind(NS);

        // Dictionaries, styles and slot cells are all effects of this plugin's
        // fiber, so unloading removes every one of them.
        ctx.effect(() => [
          ctx.locale.register(NS, "en", DICTIONARIES.en),
          ctx.locale.register(NS, "zh", DICTIONARIES.zh),
        ]);

        // `styles` is the Client's package-owned stylesheet seat; the DOM
        // fallback keeps this working if it is ever absent.
        ctx.effect(() => {
          if (typeof styles !== "undefined" && typeof styles?.insert === "function") {
            return styles.insert(CSS);
          }
          const tagId = `${PANEL_ID}/panel.css`;
          const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`);
          if (existing) return () => {};
          const tag = document.createElement("style");
          tag.dataset.plugin = PANEL_ID;
          tag.dataset.pluginCss = tagId;
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => tag.remove();
        });

        const injected = () => ({
          t,
          subscribeLocale: (fn) => ctx.locale.subscribe(fn),
          // The game session is an ordinary Session, so it uses the ordinary
          // Session services: the same catalog, the same composer, the same
          // model picker that DSH already renders inside the Conversation.
          sessions: ctx.get("sessions"),
          // Creation uses ClientSessions.create directly, not UI navigation.
          // Do not archive the playable session: archived agents cannot run.
        });

        // The central panel, keyed by the same id the sidebar entry uses. The
        // The `main` slot renders whichever body is registered under its key.
        // A failing seat must not take the others down: an exception from one used
        // to abort `apply` before the rest registered, which is how the panel once
        // became completely unreachable.
        const seat = (label, register) => {
          try {
            return register();
          } catch (error) {
            // Report, do not swallow silently: the panel staying usable matters more
            // than the seat, but the reason has to be findable.
            if (typeof console !== "undefined" && typeof console.warn === "function") {
              console.warn(`[dsh-nethack] could not register ${label}:`, error);
            }
            return () => {};
          }
        };
        const seatEffect = (label, fn) => ctx.effect(() => seat(label, fn));

        // Two slots, registered from the outside in:
        //
        //   main / sidebar.right.pane.tab
        //     └─ PANEL_SLOT (session-maybe)  -> NetHackPanel
        //          └─ CONV_SLOT (session)    -> the shipped Conversation
        //
        // The outer seat is what gives the panel the slot system's
        // `SessionProvider` (a `session`-scoped child is the only way to receive
        // it); the panel then binds that provider to the GAME's session around
        // `CONV_SLOT`, so the conversation below belongs to the game instead of
        // to whichever session the person happens to be looking at.
        const panelChildren = {
          [PANEL_SLOT]: { kind: "single", scope: "session-maybe" },
        };
        const bodyChildren = {
          [CONV_SLOT]: { kind: "single", scope: "session" },
        };

        // The sidebar entry, and the reason anyone can reach this panel at all.
        //
        // `main` is a keyed DATA slot: registering it draws nothing. The left
        // column's icon strip is `sidebar.panellist`, a LIST whose `id` is what
        // the shell dispatches into `main` on click. So the icon must name the
        // same id the panel registers under, and without this row the panel is
        // unreachable no matter how correct everything below it is.
        //
        // `label` is not the visible text (the icon is); it is what the sidebar
        // resolves for the entry's accessible name and the More menu.
        seatEffect("sidebar entry", () => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 60,
          locale: NS,
          label: () => t("panel"),
        }, NethackIcon)));

        // A child declaration authorizes renderSlot; it does not render anything
        // by itself. Both entry points must return the child outlet explicitly.
        // Forward the tab's bound visibility hook across this extra slot layer.
        const panelEntry = (placement) => (props) => props.renderSlot(PANEL_SLOT, {
          placement,
          ...(typeof props.useTabInfo === "function" ? { useTabInfo: props.useTabInfo } : {}),
        });
        seatEffect("main panel", () => ctx.slots.inject("main", () => ctx.slots.register({
          name: "main",
          key: PANEL_ID,
          locale: NS,
          inject: injected,
          children: panelChildren,
        }, panelEntry("main"))));

        seatEffect("panel body", () => ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({
          name: PANEL_SLOT,
          locale: NS,
          inject: injected,
          children: bodyChildren,
        }, NetHackPanel)));

        // The conversation seat itself. It is a plain renderer: the panel above
        // already provided the session, so all this does is name the content.
        seatEffect("conversation body", () => ctx.slots.inject(CONV_SLOT, () => ctx.slots.register({
          name: CONV_SLOT,
          locale: NS,
        }, ConversationBody)));

        // The right-column tab: the same surface dsh-remote uses for its explorer.
        // A tab is two registrations with the SAME key:
        //   - `sidebarRightTabs.register({ id, kind, title })` declares the tab, and
        //   - slot `sidebar.right.pane.tab` provides its body, keyed by that id.
        // Both live inside `inject(['sidebarRightTabs'])`, so a build without the
        // service simply never offers the tab and the centre panel still works.
        // Guarded: a ctx without `inject` (older line, or a test double) must not
        // break the seats below it. The tab is a bonus, not the panel.
        if (typeof ctx.inject === "function") ctx.inject(["sidebarRightTabs"], (inner) => {
          const tabs = inner.get("sidebarRightTabs");
          if (typeof tabs?.register !== "function") return;
          // `guide` is what puts the tab IN THE STRIP. Without it the type exists
          // but nothing appears: dsh-remote registers its visible explorer tab with
          // a guide entry and registers its bare file-preview type without one.
          // `order` places it relative to the others.
          inner.effect(() => tabs.register({
            id: TAB_ID,
            kind: TAB_ID,
            title: () => t("panel"),
            guide: [{ order: 60, title: () => t("panel") }],
          }), "dsh-nethack.tab-type");
          inner.effect(() => inner.get("slots").inject("sidebar.right.pane.tab", () => inner.get("slots").register({
            name: "sidebar.right.pane.tab",
            key: TAB_ID,
            locale: NS,
            inject: injected,
            children: panelChildren,
          }, panelEntry("tab"))), "dsh-nethack.tab-body");
        });
      },
    };
  },
});