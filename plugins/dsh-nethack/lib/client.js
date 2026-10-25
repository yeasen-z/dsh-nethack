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
  id: "dsh-nethack",
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

    /** Glyph colours by tty character, matching NetHack's own screen classes. */
    const GLYPH_CLASS = {
      "@": "hero",
      "<": "stairs", ">": "stairs",
      "#": "corridor", ".": "floor",
      "$": "gold", "*": "gold", "!": "potion", "?": "scroll", "%": "food",
      "/": "weapon", "(": "weapon", "[": "armor", "=": "ring",
      '"': "amulet", "+": "spellbook", "\\": "tool",
      "-": "wall", "|": "wall",
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
        inventory: "Carrying",
        noInventory: "Press i to look at your pack.",
        loading: "Starting NetHack…",
        unreachable: "Could not reach the game",
        asking: "The game is asking",
        reply: "Your answer",
        answer: "Answer",
        more: "--More-- (press space to continue)",
        yn: "Yes or no?",
        line: "Type your answer:",
        menu: "Choose an option by its key.",
        position: "Pick a position on the map (travel/farlook).",
        waiting: "Waiting for your reply.",
        emptyMap: "(no map yet)",
        ac: "AC", gold: "Gold", turn: "Turn", ended: "The game is over.",
        chatNoWorkspace: "No workspace is open yet, so the game cannot start its conversation.",
        chatBusySession: "The game could not claim a session of its own — it would have taken over a session you had started. Try again.",
        chatUnavailable: "DSH sessions are unavailable in this build, so the game has no chat.",
        chatFailed: "This game's conversation could not start",
        restart: "New game", keys: "Key controls", restartConfirm: "Discard this game and start over?",
        confirmRestart: "Discard and restart", cancel: "Cancel", manualHint: "Arrows or numpad to move; controls only capture keys while focused.",
        waitAction: "Wait", pickupAction: "Pick up", searchAction: "Search", openAction: "Open", descendAction: "Downstairs", ascendAction: "Upstairs",
        keyReply: "Key / answer", sendKey: "Send", continueAction: "Space", enterAction: "Enter", escapeAction: "Esc",
        chatStarting: "Starting this game's conversation…",
        chatAttaching: "Giving this conversation the game…",
      },
      zh: {
        panel: "NetHack 地牢",
        refresh: "立即刷新",
        inventory: "背包",
        noInventory: "按 i 查看背包。",
        loading: "正在启动 NetHack……",
        unreachable: "无法连接游戏",
        asking: "游戏正在询问",
        reply: "你的回答",
        answer: "回答",
        more: "--More--（按空格继续）",
        yn: "是或否？",
        line: "请输入回答：",
        menu: "请按键选择一项。",
        position: "请在地图上选一个位置（旅行/查看）。",
        waiting: "等待你的回答。",
        emptyMap: "（尚未绘制地图）",
        ac: "防御", gold: "金币", turn: "回合", ended: "游戏结束。",
        chatNoWorkspace: "还没有打开工作区，游戏无法创建自己的对话。",
        chatBusySession: "游戏没能拿到属于自己的会话——否则会占用你已经开着的那个会话。请再试一次。",
        chatUnavailable: "当前环境没有可用的 DSH 会话服务，无法开启对话。",
        chatFailed: "这一局的对话没能启动",
        restart: "重开游戏", keys: "按键操作", restartConfirm: "放弃当前进度，开始新的一局？",
        confirmRestart: "确认重开", cancel: "取消", manualHint: "方向键或小键盘移动；仅聚焦此区域时接管按键，不影响聊天输入。",
        waitAction: "等待", pickupAction: "拾取", searchAction: "搜索", openAction: "开门", descendAction: "下楼", ascendAction: "上楼",
        keyReply: "按键／回答", sendKey: "发送", continueAction: "空格", enterAction: "回车", escapeAction: "取消 Esc",
        chatStarting: "正在为这一局创建对话……",
        chatAttaching: "正在把游戏接入这个对话……",
      },
    };

    // The right column is narrow, so the whole panel is one column: a dense
    // summary bar, the fitted map, the pad, then collapsible lists. Sizes are
    // deliberately small and every colour is a host theme token.
    const CSS = `
.nhc-root { display: flex; flex-direction: column; gap: 0; height: 100%; min-height: 0;
  box-sizing: border-box; overflow: hidden;
  color: var(--dsw-alias-label-primary); font-size: 12px; }
/* The game itself, in the space a conversation transcript would occupy. It is the
   only scrolling region, so the dock below never moves. */
.nhc-canvas { display: flex; flex-direction: column; gap: 8px; flex: 2 1 0;
  min-height: 0; overflow: auto; padding: 12px; }
/* Below the map: the pack on the left, the conversation on the right. Both columns
   share the dock's height and scroll internally, so a long pack or a long
   transcript can never push the composer out of the panel. */
/* Give the conversation/pack about 60% of the flexible height; the map
   fits into the remaining 40%. Keep both usable in short panels. */
.nhc-dock { flex: 3 1 0; min-height: 260px; max-height: 65%; display: flex; align-items: stretch; gap: 10px;
  padding: 10px 12px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); }
.nhc-side { flex: 0 0 clamp(150px, 22%, 230px); min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.nhc-side > .nhc-pack { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.nhc-controls { margin-top: auto; flex: none; display: flex; flex-direction: column; gap: 6px; }
.nhc-control-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
/* The game needs at least one full open viewport, so the dock never scrolls.
   With the manual always open the map column cannot supply that height, so the
   width breakpoints below must not cap the dock; the panel scrolls instead. */
/* The manual is permanent, so it is sized to stay fully visible in the dock
   instead of scrolling: the command entry must never be pushed out of reach. */
.nhc-manual { flex: 0 0 auto; padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
.nhc-manual:focus { outline: 2px solid var(--dsw-alias-border-l2); }
.nhc-keygrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 6px 0; }
.nhc-keyreply { display: flex; gap: 4px; margin-top: 6px; }
.nhc-keyreply input { min-width: 0; width: 100%; color: inherit; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); }
.nhc-confirm { padding: 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; }
.nhc-confirm p, .nhc-manual p { margin: 0 0 6px; }
.nhc-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; }
.nhc-main .nhc-chat { flex: 1 1 auto; min-height: 0; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px; box-shadow: 0 6px 20px rgb(0 0 0 / 12%); }
/* A narrow panel stacks the two columns instead of squeezing both. */
@media (max-width: 640px) {
  .nhc-dock { flex-direction: column; }
  .nhc-side { flex: none; max-height: 34%; }
}
/* A very short panel cannot honour the 260px dock floor without starving the map.
   Below that the dock drops its floor and the two areas share the height by their
   flex ratio (2:3), which keeps both usable. A fixed canvas min-height was the
   wrong lever: it pushed the dock to 22px and the composer disappeared. */
@media (max-height: 520px) {
  .nhc-dock { min-height: 0; }
}
.nhc-bar { display: flex; align-items: center; gap: 8px; flex: none; }
.nhc-summary { flex: 1 1 auto; min-width: 0; font-size: 11px; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nhc-icon-btn { font: inherit; flex: none; width: 24px; height: 24px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.nhc-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-overlay);
  border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.nhc-icon-btn:disabled { opacity: .45; cursor: not-allowed; }
/* One card holds the whole game view. The map is its face; the facts and the
   two collapsibles are rows inside it, divided by hairlines rather than each
   carrying its own border. */
.nhc-card { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
  border-radius: 12px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); }
.nhc-map { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 10px;
  background: var(--dsw-alias-bg-layer-2); }
/* The at-a-glance row under the map: HP and AC first (larger), then the quiet
   facts, then any conditions as pills. */
.nhc-facts { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 16px;
  padding: 9px 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
.nhc-fact b { display: block; font-size: 15px; font-weight: 600; line-height: 1.15;
  font-variant-numeric: tabular-nums; }
.nhc-fact span { display: block; font-size: 10px; letter-spacing: .04em;
  color: var(--dsw-alias-label-secondary); }
.nhc-fact-key b { font-size: 17px; }
.nhc-fact-sep { width: 1px; align-self: stretch; margin: 2px 2px;
  background: var(--dsw-alias-border-l1); }
.nhc-conds { display: flex; flex-wrap: wrap; gap: 5px; margin-left: auto; }
.nhc-mapgrid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  line-height: 1.15; white-space: pre; }
.nhc-mapgrid > div { white-space: pre; }
/* Keep the actual @ legible: a filled highlight can swallow its glyph at
   small map sizes, especially when theme text/accent colors are similar. */
.nhc-g.hero { color: var(--dsw-alias-label-primary); background: transparent; font-weight: 700; }
.nhc-g.monster { color: var(--dsw-alias-state-error-primary); }
.nhc-g.wall { color: var(--dsw-alias-label-secondary); }
.nhc-g.corridor { color: var(--dsw-alias-state-idle-primary); }
.nhc-g.floor { color: var(--dsw-alias-label-secondary); opacity: .5; }
.nhc-g.stairs { color: var(--dsw-alias-state-success-primary); font-weight: 700; }
.nhc-g.gold { color: var(--dsw-alias-state-warn-primary); }
.nhc-g.potion, .nhc-g.spellbook { color: var(--dsw-alias-brand-primary); }
.nhc-g.weapon, .nhc-g.armor { color: var(--dsw-alias-label-primary); opacity: .8; }
.nhc-g.ring, .nhc-g.amulet { color: var(--dsw-alias-state-success-primary); }
.nhc-g.scroll, .nhc-g.tool, .nhc-g.food { color: var(--dsw-alias-label-secondary); }
.nhc-btn { font: inherit; font-size: 12px; display: inline-flex; align-items: center; justify-content: center;
  min-width: 34px; min-height: 28px; padding: 0 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); }
.nhc-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-overlay); border-color: var(--dsw-alias-border-l2); }
.nhc-btn:disabled { opacity: .45; cursor: not-allowed; }
/* The pack column: its own surface, matching the chat box beside it. */
.nhc-pack { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0;
  border-radius: 10px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); }
.nhc-pack-head { flex: none; display: flex; align-items: center; gap: 6px;
  padding: 8px 11px; font-size: 11px; font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  text-transform: uppercase; letter-spacing: .05em;
  border-bottom: 1px solid var(--dsw-alias-border-l1); }
.nhc-pack-count { margin-left: auto; font-family: ui-monospace, monospace;
  font-weight: 400; font-size: 10px; opacity: .75; letter-spacing: 0; }
.nhc-pack-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 8px 11px 10px; }
.nhc-pack-body .nhc-inv-item em { display: inline-block; width: 14px; flex: none;
  font-family: ui-monospace, monospace; font-style: normal;
  color: var(--dsw-alias-brand-primary); opacity: .9; }
.nhc-pack-body .nhc-inv-item span { overflow-wrap: anywhere; }
.nhc-pack-body .nhc-inv-head { margin-top: 7px; }
.nhc-pack-body .nhc-inv-head:first-child { margin-top: 0; }

/* The message ticker above the map: one line, opening in place to the history. */
.nhc-ticker { flex: none; border-radius: 8px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1); }
.nhc-ticker > summary { cursor: pointer; list-style: none; display: flex;
  align-items: center; gap: 8px; padding: 6px 10px; font-size: 11.5px;
  color: var(--dsw-alias-label-primary); }
.nhc-ticker > summary::-webkit-details-marker { display: none; }
.nhc-ticker > summary::before { content: "▸"; font-size: 9px; opacity: .65; flex: none; }
.nhc-ticker[open] > summary::before { content: "▾"; }
.nhc-ticker-text { flex: 1 1 auto; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.nhc-ticker-count { flex: none; font-family: ui-monospace, monospace; font-size: 10px;
  color: var(--dsw-alias-label-secondary); opacity: .8; }
.nhc-ticker-body { padding: 0 10px 8px 27px; border-top: 1px solid var(--dsw-alias-border-l1); }
.nhc-ticker-body .nhc-msgs { max-height: 150px; margin-top: 7px; }
.nhc-msg-latest { color: var(--dsw-alias-brand-primary); }

.nhc-msgs { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px;
  max-height: 190px; overflow: auto; }
.nhc-msgs li { font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.nhc-msgs li:last-child { color: var(--dsw-alias-brand-primary); }
/* Only the pack body scrolls (see .nhc-pack-body). The list inside it must never
   be its own scroll container: two nested scrollers showed two scrollbars for a
   single pack. */
.nhc-inv { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.nhc-inv-item { font-size: 11px; line-height: 1.35; overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.nhc-inv-head { font-size: 10px; font-weight: 600; margin-top: 4px;
  color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: .04em; }
.nhc-inv-head:first-child { margin-top: 0; }
.nhc-cond { font-size: 10px; padding: 2px 7px; border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.nhc-prompt { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; flex: none;
  border-radius: 8px; background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); padding: 9px; }
.nhc-prompt > p { flex: 1 1 100%; margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.nhc-prompt h3 { flex: 1 1 100%; margin: 0; font-size: 11px; font-weight: 600;
  color: var(--dsw-alias-state-warn-primary); text-transform: uppercase; letter-spacing: .05em; }
.nhc-input { font: inherit; font-size: 12px; flex: 1 1 96px; min-width: 0; padding: 5px 7px;
  border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.nhc-opt { justify-content: flex-start; text-align: left; max-width: 100%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.nhc-notice { margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.nhc-err { margin: 0; font-size: 11px; color: var(--dsw-alias-state-error-primary); }
/* The game's conversation is the SHIPPED Conversation content, so this panel
   styles only its seat: the content brings its own transcript, composer and
   scrolling. The seat must be a flex column with a real height or the embedded
   content collapses to nothing (its own root is height:100%). */
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
  align-items: center; flex: 1 1 auto; min-height: 0; padding: 12px; text-align: center; }
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

    /** Draw the tile set as coloured monospace rows. */
    function renderMap(tiles, t, fontPx) {
      if (!Array.isArray(tiles) || tiles.length === 0) {
        return h("div", { className: "nhc-mapgrid", style: { fontSize: "11px" } }, t("emptyMap"));
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
          const tile = at.get(`${x},${y}`);
          const glyph = tile?.text;
          if (!glyph || glyph === " ") { cells.push(" "); continue; }
          const kind = GLYPH_CLASS[glyph] ?? (MONSTER_LETTER.test(glyph) ? "monster" : "other");
          cells.push(h("span", { key: x, className: `nhc-g ${kind}` }, glyph));
        }
        rows.push(h("div", { key: y }, cells));
      }
      return h("div", { className: "nhc-mapgrid", style: { fontSize: `${fontPx}px` } }, rows);
    }

    /**
     * Board presentation, kept as small components so the panel body stays about
     * flow control: these only draw what the state route already returned.
     */

    /** HP, AC and the quiet status facts, with a refresh button. */
    function StatusBar(props) {
      const { t, state, onRefresh } = props;
      const status = state?.status ?? {};
      const conditions = Array.isArray(state?.conditions) ? state.conditions : [];
      const facts = [
        ["HP", status.BL_HP ? `${status.BL_HP}${status.BL_HPMAX ? `/${status.BL_HPMAX}` : ""}` : null],
        [t("ac"), status.BL_AC ?? null],
        [t("gold"), status.BL_GOLD ?? null],
        [t("turn"), state?.turn ?? null],
      ].filter(([, value]) => value !== null && value !== undefined && value !== "");
      return h("div", { className: "nhc-bar" },
        ...facts.map(([key, value]) =>
          h("div", { className: `nhc-fact${key === "HP" || key === t("ac") ? " nhc-fact-key" : ""}`, key },
            h("b", null, String(value)),
            h("span", null, key),
          )),
        conditions.length
          ? h("div", { className: "nhc-conds" },
              ...conditions.map((text) => h("span", { className: "nhc-cond", key: text }, text)))
          : null,
        h("button", {
          type: "button", className: "nhc-btn", title: t("refresh"), "aria-label": t("refresh"),
          onClick: onRefresh,
        }, "↻"),
      );
    }

    /**
     * The map, fitted to the space it is given.
     *
     * Both axes are measured: sizing by width alone overflowed the column in a
     * short window and scrolled the map instead of shrinking it.
     */
    function MapView(props) {
      const { t, map, player } = props;
      const [ref, size] = useElementSize();
      const tiles = Array.isArray(map) ? map : [];
      if (!tiles.length) {
        // Same card and same class as the drawn map, so the panel's structure
        // does not change shape the moment the first tiles arrive.
        return h("div", { className: "nhc-card" },
          h("div", { className: "nhc-map", ref },
            h("p", { className: "nhc-notice" }, t("emptyMap"))),
        );
      }
      const bounds = mapBounds(tiles);
      const fontPx = fitFontSize(size.width - 20, bounds.cols, size.height - 20, bounds.rows);
      return h("div", { className: "nhc-card" },
        h("div", { className: "nhc-map", ref },
          renderMap(tiles, t, fontPx),
          player ? h("div", { className: "nhc-notice" }, `@ ${player.x},${player.y}`) : null,
        ),
      );
    }

    /**
     * Whatever the engine is asking, as one prompt strip.
     *
     * Only shown when a question is pending; at the command prompt the pad below
     * is the input device and this strip stays out of the way.
     */
    function AskBar(props) {
      const { t, question, reply, setReply, busy, onAnswer } = props;
      const options = menuOptions(question);
      const key = (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onAnswer();
      };
      return h("div", { className: "nhc-prompt" },
        h("h3", null, t("asking")),
        h("p", null, promptText(question, t)),
        h("input", {
          className: "nhc-input",
          value: reply,
          placeholder: t("reply"),
          disabled: busy,
          spellCheck: false,
          onChange: (event) => setReply(event.target.value),
          onKeyDown: key,
        }),
        h("button", { type: "button", className: "nhc-btn", onClick: onAnswer, disabled: busy }, t("answer"))
        ,
        ...options.slice(0, 9).map((option) =>
          h("button", {
            key: option.key, type: "button", className: "nhc-btn nhc-opt",
            disabled: busy,
            onClick: () => setReply(option.key),
          }, `${option.key} ${option.label}`)),
      );
    }

    /** The pack column beside the conversation. */
    function Inventory(props) {
      const { t, items, gold } = props;
      return h(PackPanel, { t, state: { inventory: items, status: { BL_GOLD: gold } } });
    }

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
     * The panel body, rendered by a `session` child slot.
     *
     * The panel shows a conversation, and DSH's Conversation reads the session
     * from a React context that only a `session` slot provides. So the panel is
     * registered inside `PANEL_SLOT` (a `session` child of `main` /
     * `sidebar.right.pane.tab`) and receives the slot system's `SessionProvider`.
     *
     * Below the map it renders the GAME's session, not the current one: the panel
     * creates an ordinary DSH session with the `nethack` agent preset, tells the
     * Host to attach the game's tools to it, and then binds `SessionProvider` to
     * that session. Everything the harness already has then applies to the game
     * for free -- streaming, stop, the model picker, compaction, persistence --
     * instead of a second chat implementation living in this file.
     *
     * Isolation is enforced by the Host, not here: the three nethack_* tools are
     * registered into that session's agent scope only and the agent is
     * restricted to them, so the person's own conversation never sees the game
     * tools and this session cannot reach the workspace.
     */
    function GameControls({ t, state, busy, send }) {
      const [confirming, setConfirming] = React.useState(false);
      const [reply, setReply] = React.useState("");
      const command = state?.waiting_for === "command";
      const input = key => send(command ? { action: "raw_keys", keys: key } : { kind: "respond", reply: key });
      const button = (label, onClick, disabled = busy) => h("button", { type: "button", className: "nhc-btn", disabled, onClick }, label);
      const dirs = [["↖", "7"], ["↑", "8"], ["↗", "9"], ["←", "4"], ["·", "."], ["→", "6"], ["↙", "1"], ["↓", "2"], ["↘", "3"]];
      return h("div", { className: "nhc-controls" },
        confirming ? h("div", { className: "nhc-confirm", role: "alert" },
          h("p", null, t("restartConfirm")),
          h("div", { className: "nhc-control-buttons" },
            button(t("confirmRestart"), async () => { await send({ action: "restart" }); setConfirming(false); }),
            button(t("cancel"), () => setConfirming(false)))) : null,
        h("div", {
          className: "nhc-manual", tabIndex: 0, role: "group", "aria-label": t("keys"),
          onKeyDown: event => {
            if (busy || /^(INPUT|TEXTAREA|BUTTON)$/.test(event.target?.tagName) || event.target?.isContentEditable
              || event.ctrlKey || event.metaKey || event.altKey) return;
            const mapped = { ArrowUp: "8", ArrowDown: "2", ArrowLeft: "4", ArrowRight: "6", Escape: "\u001b", Enter: "\n" };
            const key = mapped[event.key] ?? (event.key?.length === 1 ? event.key : null);
            if (key !== null) { event.preventDefault(); input(key); }
          },
        },
          h("p", { className: "nhc-notice" }, t("manualHint")),
          h("div", { className: "nhc-keygrid" }, dirs.map(([label, key]) => h("button", {
            key, type: "button", className: "nhc-btn", disabled: busy || !!state?.ended,
            "aria-label": `${label} (${key})`, onClick: () => input(key),
          }, label))),
          h("div", { className: "nhc-control-buttons" },
            ...[["waitAction", "wait"], ["pickupAction", "pickup"], ["searchAction", "search"], ["openAction", "open"],
              ["descendAction", "descend"], ["ascendAction", "ascend"]].map(([label, action]) =>
              button(t(label), () => send({ action }), busy || !command || !!state?.ended)),
            button(t("continueAction"), () => input(" ")), button(t("enterAction"), () => input("\n")), button(t("escapeAction"), () => input("\u001b"))),
          h("form", { className: "nhc-keyreply", onSubmit: event => { event.preventDefault(); if (!busy && reply) { input(reply); setReply(""); } } },
            h("input", { value: reply, "aria-label": t("keyReply"), placeholder: t("keyReply"), disabled: busy,
              onChange: event => setReply(event.target.value) }),
            h("button", { type: "submit", className: "nhc-btn", disabled: busy || !reply }, t("sendKey")))),
        h("div", { className: "nhc-control-buttons" },
          button(t("restart"), () => setConfirming(value => !value))),
      );
    }
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

      const controls = h(GameControls, { t, state, busy, send });
      const side = h("div", { className: "nhc-side" },
        h(Inventory, { t, items: state?.inventory, gold: state?.status?.BL_GOLD }), controls);

      if (!state) {
        return h("div", { className: "nhc-root" },
          h("div", { className: "nhc-canvas" },
            h("p", { className: "nhc-notice" },
              error ? `${t("unreachable")}: ${error}` : t("loading")),
          ),
          h("div", { className: "nhc-dock" }, side, h("div", { className: "nhc-main" }, chat)),
        );
      }

      if (state.ended) {
        return h("div", { className: "nhc-root" },
          h("div", { className: "nhc-canvas" },
            h("p", { className: "nhc-notice" }, t("ended")),
          ),
          h("div", { className: "nhc-dock" }, side, h("div", { className: "nhc-main" }, chat)),
        );
      }

      const question = state.waiting_for !== "command" && state.waiting_for !== "ended" ? state : null;

      return h("div", { className: "nhc-root" },
        h("div", { className: "nhc-canvas" },
          h(MessageTicker, { state, t }),
          h(StatusBar, { t, state, map: state.map, onRefresh: load }),
          h(MapView, { t, map: state.tiles, player: state.player }),
          question ? h(AskBar, { t, question, reply, setReply, busy, onAnswer: () => send({ kind: "respond", reply }) }) : null,
          error ? h("p", { className: "nhc-err" }, error) : null,
        ),
        h("div", { className: "nhc-dock" },
          side,
          h("div", { className: "nhc-main" }, chat),
        ),
      );
    }

    /**
     * The engine's message line as a ticker: newest line, always visible.
     *
     * A `details` gives the "one line, click to expand" behaviour without any
     * state: closed it shows the single latest message, open it lists the recent
     * history. Kept as its own component so the panel body stays readable, and so
     * the collapsed state is local to it (a poll every 700 ms must not reset it).
     */
    function MessageTicker(props) {
      const { state, t } = props;
      const lines = Array.isArray(state?.messages) ? state.messages : [];
      const latest = lines[lines.length - 1] ?? "";
      if (!latest) return null;
      return h("details", { className: "nhc-ticker" },
        h("summary", { title: latest },
          h("span", { className: "nhc-ticker-text" }, latest),
          lines.length > 1
            ? h("span", { className: "nhc-ticker-count" }, String(lines.length))
            : null,
        ),
        h("div", { className: "nhc-ticker-body" },
          h("ul", { className: "nhc-msgs" },
            ...lines.slice(-14).reverse().map((text, index) =>
              h("li", { key: `${index}-${text}`, className: index === 0 ? "nhc-msg-latest" : undefined }, text))),
        ),
      );
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
        const PanelEntry = (props) => props.renderSlot(PANEL_SLOT, {
          ...(typeof props.useTabInfo === "function" ? { useTabInfo: props.useTabInfo } : {}),
        });
        seatEffect("main panel", () => ctx.slots.inject("main", () => ctx.slots.register({
          name: "main",
          key: PANEL_ID,
          locale: NS,
          inject: injected,
          children: panelChildren,
        }, PanelEntry)));

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
          }, PanelEntry)), "dsh-nethack.tab-body");
        });
      },
    };
  },
});