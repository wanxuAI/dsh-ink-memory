// 墨忆 Ink Memory — Client 半区：设置页「墨忆记忆」区（位于 Agent 预设之下）。
// 数据与操作全部走宿主 /api/ink-memory/*（与 ink_* 工具同一实现）。
window.__ModuleLoader__.load({ id: 'dsh-ink-memory', factory: (require) => { var module = { exports: {} }; var exports = module.exports;

  var react = require("react");
  var jsxRuntime = require("react/jsx-runtime");
  var jsx = jsxRuntime.jsx;
  var jsxs = jsxRuntime.jsxs;

  var PREFIX = "/api/ink-memory";
  var CATS = ["user", "project", "fact", "lesson", "note"];

  function isZh() {
    var l = String(navigator.language || "zh").toLowerCase();
    return l.indexOf("zh") === 0;
  }
  function T(zh, en) { return isZh() ? zh : en; }

  function api(pathName, options) {
    var base = { headers: { "content-type": "application/json" } };
    if (options) { for (var k in options) base[k] = options[k]; }
    return fetch(PREFIX + pathName, base).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!r.ok) {
          var err = new Error((data && data.error) || "HTTP " + r.status);
          err.data = data;
          throw err;
        }
        return data || {};
      });
    });
  }

  // ---------- 图标（墨滴） ----------
  function InkIcon(props) {
    var size = (props && props.size) || 18;
    return jsx("svg", {
      width: size, height: size, viewBox: "0 0 24 24", fill: "none",
      stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
      "aria-hidden": "true",
      children: jsx("path", { d: "M12 3c-3.2 3.6-6 6.7-6 10a6 6 0 0 0 12 0c0-3.3-2.8-6.4-6-10z" })
    });
  }

  function Chip(props) {
    return jsxs("span", {
      className: "imk-chip" + (props.tone ? " imk-chip-" + props.tone : ""),
      children: [jsx("b", { children: props.v }), " ", props.k]
    });
  }

  function Msg(props) {
    if (!props.msg) return null;
    var cls = props.msg.ok === null ? " imk-msgInfo" : props.msg.ok ? " imk-msgOk" : " imk-msgErr";
    return jsx("div", { className: "imk-msg" + cls, role: "status", children: props.msg.text });
  }

  function StateBadge(props) {
    if (props.state === "active") return null;
    if (props.state === "forgotten") return jsx("span", { className: "imk-badge imk-badgeWarn", children: T("已淡出", "forgotten") });
    if (String(props.state).indexOf("superseded") === 0) return jsx("span", { className: "imk-badge imk-badgeDim", children: T("被取代", "superseded") });
    return jsx("span", { className: "imk-badge", children: props.state });
  }

  // ---------- 单条记忆 ----------
  function MemRow(props) {
    var m = props.m;
    var editing = props.editingId === m.id;
    var setEdit = props.setEditingId;
    var btns = [];
    if (editing) {
      btns.push(
        jsx("button", { className: "imk-btn imk-btnPrimary", key: "save", disabled: props.busy, onClick: function () { props.saveEdit(m); }, children: T("保存", "Save") }),
        jsx("button", { className: "imk-btn", key: "cancel", onClick: function () { setEdit(null); }, children: T("取消", "Cancel") })
      );
    } else {
      btns.push(
        jsx("button", { className: "imk-btn", key: "edit", onClick: function () { setEdit(m.id); props.setEditText(m.text); }, children: T("编辑", "Edit") }),
        m.durable
          ? jsx("button", { className: "imk-btn", key: "pin", disabled: props.busy, onClick: function () { props.op("pin", { id: m.id, durable: false }); }, children: T("取消钉", "Unpin") })
          : jsx("button", { className: "imk-btn", key: "pin", disabled: props.busy, onClick: function () { props.op("pin", { id: m.id, durable: true }); }, children: T("钉住", "Pin") }),
        m.state === "active"
          ? jsx("button", { className: "imk-btn", key: "forget", disabled: props.busy, onClick: function () { props.op("forget", { id: m.id }); }, children: T("淡出", "Fade") })
          : jsx("button", { className: "imk-btn", key: "re", disabled: props.busy, onClick: function () { props.op("reinstate", { id: m.id }); }, children: T("恢复", "Restore") }),
        jsx("button", {
          className: "imk-btn imk-btnDanger", key: "del", disabled: props.busy,
          onClick: function () {
            if (!window.confirm(T("彻底删除这条记忆？此操作不可恢复：\n", "Delete permanently? This cannot be undone:\n") + m.text)) return;
            props.op("delete", { id: m.id });
          },
          children: T("删除", "Delete")
        })
      );
    }
    return jsxs("div", {
      className: "imk-row" + (m.state !== "active" ? " imk-rowDim" : ""),
      children: [
        editing
          ? jsx("textarea", { className: "imk-input imk-textarea", value: props.editText, onChange: function (e) { props.setEditText(e.target.value); } })
          : jsx("div", { className: "imk-text", children: m.text }),
        jsxs("div", {
          className: "imk-meta",
          children: [
            jsx("span", { className: "imk-badge", children: m.category }),
            m.key ? jsx("span", { className: "imk-badge imk-badgeKey", children: m.key }) : null,
            m.durable ? jsx("span", { className: "imk-badge imk-badgePin", children: T("钉", "pinned") }) : null,
            m.scope === "session" ? jsx("span", { className: "imk-badge imk-badgeDim", children: T("仅本会话", "session-only") }) : null,
            m.freshness !== undefined ? jsx("span", { className: "imk-badge", children: T("鲜", "fresh") + " " + m.freshness }) : null,
            StateBadge({ state: m.state }),
            jsx("span", { className: "imk-dim", children: m.updated + " · " + T(m.ageDays + " 天前", m.ageDays + "d") + " · " + T("命中", "hits") + " " + (m.hits ?? 0) }),
            jsx("span", { className: "imk-spacer" }),
            jsx("span", { className: "imk-id imk-dim", children: m.id })
          ]
        }),
        jsx("div", { className: "imk-actions", children: btns })
      ]
    });
  }

  // ---------- 面板 ----------
  function InkSettings() {
    var statusState = react.useState(null);
    var listState = react.useState(null);       // /list 或 /search 的展示结果
    var modeState = react.useState("list");     // list | search
    var qState = react.useState("");            // 已提交的查询
    var qInputState = react.useState("");
    var catState = react.useState("");
    var allState = react.useState(false);
    var loadingState = react.useState(false);
    var busyState = react.useState(false);
    var msgState = react.useState(null);
    var errState = react.useState("");

    var addTextState = react.useState("");
    var addCatState = react.useState("note");
    var addKeyState = react.useState("");
    var addPinState = react.useState(false);

    var editingIdState = react.useState(null);
    var editTextState = react.useState("");

    function load(nextQ, nextMode, nextCat, nextAll) {
      var q = nextQ !== undefined ? nextQ : qState[0];
      var mode = nextMode !== undefined ? nextMode : modeState[0];
      var cat = nextCat !== undefined ? nextCat : catState[0];
      var all = nextAll !== undefined ? nextAll : allState[0];
      loadingState[1](true);
      errState[1]("");
      var listP = mode === "search"
        ? api("/search?q=" + encodeURIComponent(q) + "&limit=20").then(function (d) {
            var cs = cat ? (d.results || []).filter(function (r) { return r.category === cat; }) : (d.results || []);
            return { count: cs.length, items: cs };
          })
        : api("/list?q=" + encodeURIComponent(q || "") + "&all=" + (all ? "1" : "0"))
            .then(function (d) {
              var items = d.items || [];
              if (cat) items = items.filter(function (r) { return r.category === cat; });
              return { count: items.length, items: items };
            });
      Promise.all([api("/status"), listP])
        .then(function (rs) {
          statusState[1](rs[0]);
          listState[1](rs[1]);
        })
        .catch(function (err) {
          errState[1](T("加载失败：", "Load failed: ") + String((err && err.message) || err) +
            T("（若刚安装/升级插件，请重启 DSH 后再刷新本页）", "(if the plugin was just installed/updated, restart DSH then refresh)"));
        })
        .then(function () { loadingState[1](false); });
    }

    react.useEffect(function () { load("", "list", "", false); }, []);

    function op(path, body) {
      busyState[1](true);
      msgState[1](null);
      api("/" + path, { method: "POST", body: JSON.stringify(body) })
        .then(function () { msgState[1]({ ok: true, text: T("已更新", "Done") }); load(); })
        .catch(function (err) { msgState[1]({ ok: false, text: String((err && err.message) || err) }); })
        .then(function () { busyState[1](false); });
    }

    function saveEdit(m) {
      op("update", { id: m.id, text: editTextState[0] });
      editingIdState[1](null);
    }

    function addRemember() {
      var text = addTextState[0].trim();
      if (!text) { msgState[1]({ ok: false, text: T("先写点什么", "Type something first") }); return; }
      busyState[1](true);
      api("/remember", {
        method: "POST",
        body: JSON.stringify({ text: text, category: addCatState[0], key: addKeyState[0].trim() || null, durable: addPinState[0] }),
      })
        .then(function (d) {
          if (d && d.error) { msgState[1]({ ok: false, text: d.error }); return; }
          msgState[1]({ ok: true, text: T("已记录 ", "Recorded ") + (d.id || "") + (d.deduped ? T("（并入旧条目）", " (merged)") : "") + (d.superseded && d.superseded.length ? T("，取代 ", " (supersedes ") + d.superseded.join(",") + ")" : "") });
          addTextState[1](""); addKeyState[1](""); addPinState[1](false);
          load();
        })
        .catch(function (err) { msgState[1]({ ok: false, text: String((err && err.message) || err) }); })
        .then(function () { busyState[1](false); });
    }

    function submitSearch() {
      var q = qInputState[0].trim();
      qState[1](q);
      if (q) { modeState[1]("search"); load(q, "search"); }
      else { modeState[1]("list"); load("", "list"); }
    }

    var st = statusState[0];
    var items = listState[0] ? listState[0].items : null;
    var flags = st ? Object.entries(st.sessionFlags || {}) : [];

    return jsxs("div", {
      className: "imk-root",
      children: [
        // 头部
        jsxs("div", {
          className: "imk-header",
          children: [
            jsx(InkIcon, { size: 20 }),
            jsxs("div", {
              className: "imk-headText",
              children: [
                jsx("div", { className: "imk-title", children: T("墨忆记忆", "Ink Memory") }),
                jsx("div", { className: "imk-sub", children: st ? jsx("code", { children: st.store.dir }) : T("跨会话长期记忆", "cross-session long-term memory") })
              ]
            }),
            jsx("button", { className: "imk-btn", onClick: function () { load(); }, disabled: loadingState[0], children: loadingState[0] ? T("刷新中…", "Refreshing…") : T("刷新", "Refresh") })
          ]
        }),

        errState[0] ? jsx("div", { className: "imk-note imk-noteErr", children: errState[0] }) : null,
        st && st.store.loadError ? jsx("div", { className: "imk-note imk-noteErr", children: "store: " + st.store.loadError }) : null,

        // 状态条
        st ? jsxs("div", {
          className: "imk-chips",
          children: [
            jsx(Chip, { v: st.store.active, k: T("现行", "active") }),
            jsx(Chip, { v: st.store.durable, k: T("已钉", "pinned") }),
            jsx(Chip, { v: st.store.superseded, k: T("被取代", "superseded") }),
            jsx(Chip, { v: st.store.softDeleted, k: T("已淡出", "faded") }),
            jsx(Chip, { v: st.today.autoCaptured + "/" + st.config.dailyQuota, k: T("今日蒸馏", "auto today") }),
            jsx(Chip, { v: st.today.agentCaptured, k: T("今日记录", "recorded today") }),
            jsx("span", { className: "imk-dim imk-cfg", children: T("半衰期 ", "half-life ") + st.config.halfLifeDays + T(" 天 · 注入≤", "d · inject ≤") + st.config.recallLimit + T(" 条/", " / ") + st.config.charBudget + T(" 字 · 自动蒸馏", " chars · auto-extract") + (st.config.autoExtract ? T("开", " on") : T("关", " off")) })
          ]
        }) : null,

        Msg({ msg: msgState[0] }),

        // 快速记录
        jsxs("div", {
          className: "imk-card",
          children: [
            jsx("h3", { children: T("快速记录", "Quick record") }),
            jsx("textarea", {
              className: "imk-input imk-textarea", placeholder: T("一条自包含的长期事实，8~120 字…", "One self-contained long-term fact…"),
              value: addTextState[0], onChange: function (e) { addTextState[1](e.target.value); }
            }),
            jsxs("div", {
              className: "imk-formRow",
              children: [
                jsx("select", { className: "imk-input imk-select", value: addCatState[0], onChange: function (e) { addCatState[1](e.target.value); }, children: CATS.map(function (c) { return jsx("option", { value: c, children: c }, c); }) }),
                jsx("input", { className: "imk-input imk-key", placeholder: T("key（可选，如 用户.语言偏好）", "key (optional)"), value: addKeyState[0], onChange: function (e) { addKeyState[1](e.target.value); } }),
                jsxs("label", { className: "imk-check", children: [jsx("input", { type: "checkbox", checked: addPinState[0], onChange: function (e) { addPinState[1](e.target.checked); } }), T("钉住（不淡忘）", "pin")] }),
                jsx("button", { className: "imk-btn imk-btnPrimary", onClick: addRemember, disabled: busyState[0], children: T("记录", "Record") })
              ]
            })
          ]
        }),

        // 检索
        jsxs("div", {
          className: "imk-card",
          children: [
            jsx("h3", { children: T("记忆库", "Memory library") + (items ? "（" + items.length + "）" : "") }),
            jsxs("div", {
              className: "imk-formRow",
              children: [
                jsx("input", {
                  className: "imk-input imk-search", placeholder: T("搜索 / 语义检索（回车）…", "Search (Enter)…"),
                  value: qInputState[0],
                  onChange: function (e) { qInputState[1](e.target.value); },
                  onKeyDown: function (e) { if (e.key === "Enter") submitSearch(); }
                }),
                jsx("button", { className: "imk-btn", onClick: submitSearch, disabled: loadingState[0], children: T("检索", "Search") }),
                (qState[0] || modeState[0] === "search") ? jsx("button", { className: "imk-btn", onClick: function () { qState[1](""); qInputState[1](""); modeState[1]("list"); load("", "list"); }, children: T("回到列表", "Back to list") }) : null,
                jsx("select", { className: "imk-input imk-select", value: catState[0], onChange: function (e) { catState[1](e.target.value); load(undefined, undefined, e.target.value); }, children: [jsx("option", { value: "", children: T("全部类别", "all categories") })].concat(CATS.map(function (c) { return jsx("option", { value: c, children: c }, c); })) }),
                jsxs("label", { className: "imk-check", children: [jsx("input", { type: "checkbox", checked: allState[0], onChange: function (e) { allState[1](e.target.checked); load(undefined, undefined, undefined, e.target.checked); } }), T("含淡出/被取代", "include faded")] })
              ]
            }),
            items === null
              ? jsx("div", { className: "imk-empty", children: T("加载中…", "Loading…") })
              : items.length === 0
                ? jsx("div", { className: "imk-empty", children: T("还没有记忆。在对话里说「记住…」，或用上面的快速记录。", "No memories yet. Say \u201cremember…\u201d in a chat, or use Quick record above.") })
                : jsx("div", { className: "imk-list", children: items.map(function (m) {
                    return jsx(MemRow, {
                      m: m, busy: busyState[0], op: op,
                      editingId: editingIdState[0], setEditingId: editingIdState[1],
                      editText: editTextState[0], setEditText: editTextState[1], saveEdit: saveEdit
                    }, m.id);
                  }) })
          ]
        }),

        // 会话开关
        jsxs("div", {
          className: "imk-card",
          children: [
            jsx("h3", { children: T("会话注入开关", "Per-session injection") }),
            jsx("p", { className: "imk-hint", children: T("默认", "Default: ") + (st && st.config.enabledByDefault ? T("全部会话开启", "on for all sessions") : T("全部会话关闭", "off for all sessions")) + T("。下表只列改过开关的会话；「重置」恢复默认。开关只影响自动注入，ink_remember / ink_search 始终可用。", ". Only overridden sessions are listed; Reset restores the default. Injection only — the tools always work.") }),
            flags.length === 0
              ? jsx("div", { className: "imk-empty", children: T("没有会话改过开关", "No overridden sessions") })
              : jsx("div", { className: "imk-list", children: flags.map(function (f) {
                  return jsxs("div", { className: "imk-row imk-rowFlat", children: [
                    jsx("code", { className: "imk-id", children: f[0] }),
                    jsx("span", { className: f[1] && f[1].enabled ? "imk-badge imk-badgeOk" : "imk-badge imk-badgeWarn", children: f[1] && f[1].enabled ? T("开", "on") : T("关", "off") }),
                    jsx("span", { className: "imk-spacer" }),
                    jsx("button", { className: "imk-btn", disabled: busyState[0], onClick: function () { op("session", { session: f[0], enabled: null }); }, children: T("重置", "Reset") })
                  ] }, f[0]);
                }) })
          ]
        }),

        // 注入留痕
        st ? jsxs("div", {
          className: "imk-card",
          children: [
            jsx("h3", { children: T("最近注入留痕", "Recent recall log") }),
            jsx("p", { className: "imk-hint", children: T("每次对话评估带入了哪些记忆（hits）。「为什么没带入」：分数低于下限、超出条数或字符预算都会被排除。", "Each turn logs what was injected (hits). Below-threshold / over-budget items are excluded.") }),
            (st.lastRecalls || []).length === 0
              ? jsx("div", { className: "imk-empty", children: T("暂无记录", "Nothing logged") })
              : jsx("div", { className: "imk-log", children: st.lastRecalls.map(function (r, i) {
                  return jsxs("div", { className: "imk-logRow", children: [
                    jsx("span", { className: "imk-dim", children: (r.at || "").replace("T", " ").slice(5, 16) }),
                    jsx("span", { className: "imk-logQ", children: (r.q || "").slice(0, 42) }),
                    jsx("span", { className: "imk-badge" + ((r.hits || []).length ? " imk-badgeOk" : ""), children: "hits " + ((r.hits || []).length) })
                  ] }, i);
                }) }),
            (st.recentErrors || []).length ? jsx("div", { className: "imk-errs", children: st.recentErrors.map(function (e, i) { return jsx("div", { className: "imk-msg imk-msgErr", children: (e.at || "") + " " + (e.error || "") }, i); }) }) : null
          ]
        }) : null
      ]
    });
  }

  // ---------- 样式（继承宿主主题 token） ----------
  function apply(ctx) {
    ctx.effect(() => {
      var css = `
.imk-root{display:flex;flex-direction:column;gap:12px;width:100%;padding:4px 2px 24px;color:var(--dsw-alias-label-primary,#1f2329);font-size:14px}
.imk-header{display:flex;align-items:center;gap:12px}
.imk-headText{flex:1 1 auto;min-width:0}
.imk-title{font-size:16px;font-weight:600}
.imk-sub{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}
.imk-sub code{font-family:ui-monospace,Consolas,monospace;font-size:11px}
.imk-chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.imk-chip{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:999px;padding:2px 10px}
.imk-chip b{color:var(--dsw-alias-label-primary,#1f2329)}
.imk-cfg{font-size:11px}
.imk-card{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-base,#ffffff)}
.imk-card h3{margin:0 0 8px;font-size:13px;font-weight:600}
.imk-hint{margin:0 0 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.5}
.imk-input{box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d7dbe0);background:var(--dsw-alias-bg-base,#ffffff);font-size:13px;font-family:inherit;color:inherit}
.imk-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#2563eb)}
.imk-textarea{width:100%;min-height:64px;resize:vertical;line-height:1.5}
.imk-search{flex:1 1 auto;min-width:160px}
.imk-key{flex:1 1 200px;min-width:140px}
.imk-select{flex:none}
.imk-formRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px}
.imk-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}
.imk-btn{padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d7dbe0);background:var(--dsw-alias-bg-base,#ffffff);font-size:12px;cursor:pointer;color:inherit;font-family:inherit}
.imk-btn:hover{border-color:var(--dsw-alias-brand-primary,#2563eb)}
.imk-btn:disabled{opacity:.5;cursor:default}
.imk-btnPrimary{background:var(--dsw-alias-brand-primary,#2563eb);border-color:var(--dsw-alias-brand-primary,#2563eb);color:#fff}
.imk-btnDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626)}
.imk-msg{font-size:12px;line-height:1.5;word-break:break-all;white-space:pre-wrap}
.imk-msgOk{color:var(--dsw-alias-state-success-primary,#16a34a)}
.imk-msgErr{color:var(--dsw-alias-state-error-primary,#dc2626)}
.imk-msgInfo{color:var(--dsw-alias-label-secondary,#6b7280)}
.imk-note{font-size:12px;border-radius:8px;padding:8px 12px;line-height:1.5}
.imk-noteErr{color:var(--dsw-alias-state-error-primary,#dc2626);border:1px solid var(--dsw-alias-state-error-primary,#dc2626)}
.imk-list{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.imk-row{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.imk-rowFlat{flex-direction:row;align-items:center}
.imk-rowDim{opacity:.6}
.imk-text{line-height:1.5;word-break:break-word}
.imk-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.imk-badge{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#d7dbe0);color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.6}
.imk-badgeKey{font-family:ui-monospace,Consolas,monospace}
.imk-badgePin{color:var(--dsw-alias-brand-primary,#2563eb);border-color:var(--dsw-alias-brand-primary,#2563eb)}
.imk-badgeWarn{color:#b45309;border-color:#fcd34d;background:#fffbeb}
.imk-badgeOk{color:var(--dsw-alias-state-success-primary,#16a34a);border-color:var(--dsw-alias-state-success-primary,#16a34a)}
.imk-badgeDim{opacity:.7}
.imk-dim{font-size:11px;color:var(--dsw-alias-label-tertiary,#9ca3af)}
.imk-id{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#9ca3af)}
.imk-spacer{flex:1 1 auto}
.imk-actions{display:flex;gap:6px;flex-wrap:wrap}
.imk-empty{padding:18px 10px;text-align:center;color:var(--dsw-alias-label-secondary,#6b7280);font-size:13px}
.imk-log{display:flex;flex-direction:column;gap:4px}
.imk-logRow{display:flex;gap:10px;align-items:center;font-size:12px}
.imk-logQ{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#6b7280)}
.imk-errs{margin-top:8px;display:flex;flex-direction:column;gap:4px}`;
      var style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
      return function () { style.remove(); };
    }, "dsh-ink-memory: styles");

    // 设置页区块：agent-presets(order 20) 之下 → 25
    ctx.slots.inject("settings.section", function () {
      return ctx.slots.register({
        name: "settings.section",
        id: "ink-memory",
        order: 25,
        label: function () { return T("墨忆记忆", "Ink Memory"); }
      }, InkSettings);
    }, "dsh-ink-memory: settings section");
  }

  exports.apply = apply;
  exports.inject = ["slots"];
  return module.exports;
} });
