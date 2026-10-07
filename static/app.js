/* 小剧场排练 · 剧本换版 —— 原生 JavaScript（无框架、无构建、无外部依赖）
 *
 * 路由（hash）：
 *   #/                      首页：工作稿概览 + 角色确认清单 + 发布列表 + 改词建议入口
 *   #/edit                 编辑工作稿（增删 / 改派 / 改词 / 重排，一次保存一个修订）
 *   #/role/:角色           角色页（提示 + 自己的台词笔记 + 改词建议 + 确认本页所见内容）
 *   #/review               改词审阅（原文 / 当前正文 / 建议并排，采纳或驳回）
 *   #/pub/:rev             已发布版（全剧只读）
 *   #/pub/:rev/role/:角色  已发布版的角色页（冻结提示 + 冻结笔记）
 */
"use strict";

const appEl = document.getElementById("app");
const toastEl = document.getElementById("toast");
let toastTimer = null;

// ---------------------------------------------------------------- 工具函数 //
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = "toast"), 3200);
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.message) || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data || {};
    throw err;
  }
  return data;
}

function staleBanner(err) {
  const d = err.data || {};
  return `<div class="banner error"><strong>修订过期：</strong>${esc(d.message || err.message)}</div>`;
}

function noteBlockBanner(conflicts) {
  const lis = (conflicts || []).map((c) => {
    const url = `#/role/${encodeURIComponent(c.character)}`;
    return `<li>${esc(c.message)}　<a href="${url}" target="_blank" rel="noopener">去处理（${esc(c.character)}角色页）</a></li>`;
  }).join("");
  return `<div class="banner error"><strong>整次修改被拒绝，没有任何改动生效。</strong>
    带笔记的台词不能删除或改派给别的角色（否则笔记会落到别的台词 / 角色上）：
    <ul>${lis}</ul></div>`;
}

// ---------------------------------------------------------------- 路由 ---- //
function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const parts = raw.split("/").filter(Boolean).map(decodeURIComponent);
  return parts;
}

function navigate() {
  const parts = parseHash();
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.remove("active"));
  const key = parts[0] || "home";
  const navMap = { "": "home", edit: "edit", review: "review" };
  const active = navMap[parts[0]];
  if (active) {
    const a = document.querySelector(`[data-nav="${active}"]`);
    if (a) a.classList.add("active");
  }

  appEl.innerHTML = '<p class="muted">加载中…</p>';
  const route = parts[0];
  try {
    if (!route) return renderHome();
    if (route === "edit") return renderEditor();
    if (route === "role") return renderRole(parts[1]);
    if (route === "review") return renderReview();
    if (route === "pub" && parts[1] !== undefined && parts[2] === "role")
      return renderPubRole(Number(parts[1]), parts[3]);
    if (route === "pub" && parts[1] !== undefined)
      return renderPub(Number(parts[1]));
    return renderNotFound();
  } catch (e) {
    renderError(e);
  }
}

function renderError(e) {
  if (e && e.status) {
    appEl.innerHTML = `<div class="banner error">${esc(e.message)}</div>
      <p><a class="link" href="#/">返回首页</a></p>`;
  } else {
    console.error(e);
    appEl.innerHTML = `<div class="banner error">页面出错：${esc(e && e.message || e)}</div>`;
  }
}

function renderNotFound() {
  appEl.innerHTML = `<h1>页面不存在</h1><p><a class="link" href="#/">返回首页</a></p>`;
}

window.addEventListener("hashchange", navigate);

// ---------------------------------------------------------------- 首页 ---- //
async function renderHome() {
  const [draft, pubs, confs, sugg] = await Promise.all([
    api("GET", "/api/draft"),
    api("GET", "/api/publications"),
    api("GET", "/api/confirmations"),
    api("GET", "/api/suggestions"),
  ]);
  const confMap = new Map(confs.confirmations.map((c) => [c.character, c]));
  const pendingChars = confs.confirmations.filter((c) => c.status === "pending");
  const charChips = draft.characters.length
    ? draft.characters.map((c) => {
        const cf = confMap.get(c);
        const ok = cf && cf.status === "confirmed";
        return `<a class="chip work ${ok ? "ok" : "pend"}"
            href="#/role/${encodeURIComponent(c)}"
            title="${ok ? "已确认确认时所见内容" : "有待确认内容，点击进入角色页"}">${
            ok ? "✔ " : "⏳ "}${esc(c)}</a>`;
      }).join("")
    : '<span class="muted small">（暂无角色，没有需要确认的台词）</span>';

  const confList = confs.confirmations.map((c) => {
    const ok = c.status === "confirmed";
    return `<li class="${ok ? "" : "pending"}">
      <span class="conf-dot ${ok ? "ok" : "pend"}"></span>
      <strong>${esc(c.character)}</strong>
      <span class="muted small">${
        ok
          ? `已确认 r${c.confirmedRevision} 的所见内容 · ${fmtTime(c.confirmedAt)}`
          : (c.confirmedRevision != null
              ? `待确认：r${c.confirmedRevision} 确认过的内容已发生变化`
              : "待确认：尚未确认过自己角色页的内容")
      }</span>
      <span class="spacer"></span>
      <a class="btn ${ok ? "" : "primary"}"
         href="#/role/${encodeURIComponent(c.character)}">${ok ? "打开角色页" : "去确认 →"}</a>
    </li>`;
  }).join("");

  const pubList = pubs.publications.map((p) => {
    const frozen = p.revision === pubs.workingRevision;
    return `<li>
      <strong>r${p.revision}</strong>
      <span class="muted small">${esc(p.label || "未命名版本")} · ${fmtTime(p.createdAt)}
        · ${p.lineCount} 句 · ${p.noteCount} 条笔记</span>
      <span class="spacer"></span>
      <a class="btn" href="#/pub/${p.revision}">打开旧版</a>
      ${p.characters.map((c) =>
        `<a class="chip" href="#/pub/${p.revision}/role/${encodeURIComponent(c)}">${esc(c)}页</a>`).join("")}
    </li>`;
  }).join("");

  const unpub = pubs.publications.some((p) => p.revision === pubs.workingRevision);
  const canPublish = pendingChars.length === 0;
  appEl.innerHTML = `
    <h1>工作稿<span class="rev-badge">当前修订 r${draft.revision}</span></h1>
    <p class="muted">角色页只显示本角色的台词与每句紧前一句的提示；重排后提示自动重算，笔记始终跟随原台词编号。</p>

    <div class="panel">
      <div class="row">
        <div><strong>${draft.lines.length}</strong> 句台词，
          <strong>${draft.characters.length}</strong> 个角色
          ${unpub ? "" : `<span class="rev-badge">有未发布改动</span>`}</div>
        <span class="spacer"></span>
        <a class="btn" href="#/edit">✎ 编辑工作稿</a>
        <button class="primary" id="publish-btn"
          title="${canPublish ? "" : "有待确认角色，发布会被拒绝"}">
          📷 发布当前修订 r${draft.revision}</button>
      </div>
      <div style="margin-top:12px">${charChips}</div>
    </div>

    <h2>角色确认清单</h2>
    <div class="panel">
      <p class="muted small">确认只覆盖该角色当时角色页所见的
        <strong>台词编号与顺序、正文、紧前提示和笔记</strong>；
        这些内容变化才会重新变为待确认，其他角色的无关改动不影响已确认状态。</p>
      ${confList
        ? `<ul class="vlist conf-list">${confList}</ul>`
        : '<p class="muted small">当前没有台词，确认清单为空。</p>'}
      ${pendingChars.length
        ? `<div class="banner warn" style="margin-bottom:0">
             <strong>有 ${pendingChars.length} 个角色待确认：</strong>
             ${pendingChars.map((c) =>
               `<a href="#/role/${encodeURIComponent(c.character)}">${esc(c.character)}</a>`).join("、")}
             。有待确认角色时发布会被整次拒绝。
           </div>`
        : ""}
    </div>

    <h2>已发布版（冻结快照，旧版仍可打开）</h2>
    <div class="panel">
      ${pubList.length ? `<ul class="vlist">${pubList}</ul>` : '<p class="muted">尚未发布。</p>'}
    </div>

    <h2>改词建议</h2>
    <div class="panel">
      <div class="row">
        <div>角色在自己角色页提出的改词建议只供编辑审阅，<strong>不会直接改稿</strong>。
          当前有
          <strong class="${sugg.pendingCount ? "conf-pending" : "conf-ok"}">${sugg.pendingCount}</strong>
          条待处理建议（另有
          ${sugg.suggestions.filter((s) => s.status === "adopted").length} 条已采纳、
          ${sugg.suggestions.filter((s) => s.status === "rejected").length} 条已驳回）。</div>
        <span class="spacer"></span>
        <a class="btn ${sugg.pendingCount ? "primary" : ""}" href="#/review">
          ${sugg.pendingCount ? `集中审阅（${sugg.pendingCount} 条待处理）→` : "打开审阅页"}</a>
      </div>
    </div>`;

  document.getElementById("publish-btn").addEventListener("click", async () => {
    if (pendingChars.length) {
      toast(`发布被拒绝：还有 ${pendingChars.length} 个角色待确认（${
        pendingChars.map((c) => c.character).join("、")}）`, true);
      const first = document.querySelector(".conf-list li.pending a.btn");
      if (first) first.focus();
      return;
    }
    const label = prompt(`把当前工作稿修订 r${draft.revision} 冻结发布。\n可选：给这个版本起个名字（留空即可）：`, "");
    if (label === null) return;
    try {
      const p = await api("POST", "/api/publications", { revision: draft.revision, label: label.trim() });
      toast(`已发布 r${p.revision}，所有角色页与笔记已冻结`);
      navigate();
    } catch (e) {
      if (e.status === 409 || e.status === 422) {
        toast(e.message, true);
        navigate();
      } else {
        toast(e.message, true);
      }
    }
  });
}

// ---------------------------------------------------------------- 编辑器 -- //
let editorState = null; // { revision, rows: [{key, id, isNew, character, text, deleted, note?}] }

async function renderEditor() {
  const draft = await api("GET", "/api/draft");
  editorState = {
    revision: draft.revision,
    characters: new Set(draft.characters),
    rows: draft.lines.map((l) => ({
      key: `l${l.id}`, id: l.id, isNew: false,
      character: l.character, text: l.text, deleted: false,
      hasNote: !!l.note,
    })),
  };
  drawEditor(null);
}

function drawEditor(bannerHtml) {
  const s = editorState;
  const datalist = [...s.characters].sort().map((c) => `<option value="${esc(c)}">`).join("");
  const active = s.rows.filter((r) => !r.deleted);
  const removed = s.rows.filter((r) => r.deleted);

  const rowsHtml = active.map((r, i) => `
    <div class="line-row" data-key="${esc(r.key)}">
      <div class="line-num">#${r.isNew ? "新" : r.id}
        ${r.hasNote ? '<span class="note-tag note-flag" title="该台词有笔记">有笔记</span>' : ""}
      </div>
      <input class="line-char" list="char-list" value="${esc(r.character)}" placeholder="角色" />
      <textarea class="line-text" rows="2" placeholder="台词正文">${esc(r.text)}</textarea>
      <div class="line-actions">
        <button class="icon" data-act="up" ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="icon" data-act="down" ${i === active.length - 1 ? "disabled" : ""}>↓</button>
        <button class="icon danger" data-act="delete"
          ${r.hasNote ? 'title="有笔记：需先到角色页清空笔记才能删除（保存时也会被整次拒绝）"' : ""}>删</button>
      </div>
    </div>`).join("");

  const tray = removed.length ? `
    <div class="panel" style="border-style:dashed">
      <h3>本次待删除（保存后生效；带笔记的删除会被整次拒绝）</h3>
      ${removed.map((r) => `
        <div class="row" style="margin-top:8px">
          <span class="line-num">#${r.isNew ? "新" : r.id}</span>
          <span class="small muted">${esc(r.character)}：${esc(r.text.slice(0, 40))}${r.text.length > 40 ? "…" : ""}
            ${r.hasNote ? '<span class="note-flag">有笔记，需先处理</span>' : ""}</span>
          <span class="spacer"></span>
          <button class="icon" data-act="restore" data-key="${esc(r.key)}">撤销删除</button>
        </div>`).join("")}
    </div>` : "";

  appEl.innerHTML = `
    <h1>编辑工作稿<span class="rev-badge">所见修订 r${s.revision}</span></h1>
    <p class="muted small">所有改动先暂存在本页，点「保存为新修订」后一次性提交：
      增删 / 改派 / 改词 / 重排只产生 <strong>一个</strong> 新修订。
      编号永不复用；台词编号是笔记的唯一锚点。</p>
    <div id="banner-slot">${bannerHtml || ""}</div>

    <div class="toolbar">
      <button id="add-top">＋ 开头加一句</button>
      <button id="add-bottom">＋ 结尾加一句</button>
      <span class="spacer"></span>
      <span class="small muted">编辑期间他人若发布 / 改稿 / 存笔记，保存会被拒绝并提示刷新</span>
      <button class="primary" id="save-btn">保存为新修订</button>
    </div>

    <datalist id="char-list">${datalist}</datalist>
    <div id="line-list">${rowsHtml || '<div class="empty">工作稿是空的，先加一句台词。</div>'}</div>
    ${tray}`;

  bindEditorEvents();
}

function bindEditorEvents() {
  const s = editorState;
  const findRow = (key) => s.rows.find((r) => r.key === key);
  const activeKeys = () => s.rows.filter((r) => !r.deleted).map((r) => r.key);

  document.getElementById("add-top").onclick = () => addRow(true);
  document.getElementById("add-bottom").onclick = () => addRow(false);

  function addRow(atTop) {
    syncInputs();
    const key = `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const row = { key, id: null, isNew: true, character: "", text: "", deleted: false, hasNote: false };
    if (atTop) s.rows.unshift(row); else s.rows.push(row);
    drawEditor(document.getElementById("banner-slot")?.innerHTML || "");
    const el = appEl.querySelector(`.line-row[data-key="${CSS.escape(key)}"] textarea`);
    if (el) el.focus();
  }

  appEl.querySelectorAll(".line-row").forEach((el) => {
    const key = el.dataset.key;
    el.querySelector('[data-act="up"]').onclick = () => moveBy(key, -1);
    el.querySelector('[data-act="down"]').onclick = () => moveBy(key, 1);
    el.querySelector('[data-act="delete"]').onclick = () => {
      syncInputs();
      const r = findRow(key);
      if (r && r.hasNote &&
          !confirm(`台词 #${r.id}（${r.character}）仍有笔记。\n` +
                   "删除会在保存时被整次拒绝，需要先到该角色页清空或改写笔记。\n\n仍要标记为待删除吗？")) {
        return;
      }
      if (r) r.deleted = true;
      drawEditor(document.getElementById("banner-slot")?.innerHTML || "");
    };
  });
  appEl.querySelectorAll('[data-act="restore"]').forEach((b) => {
    b.onclick = () => {
      const r = findRow(b.dataset.key);
      if (r) r.deleted = false;
      drawEditor(document.getElementById("banner-slot")?.innerHTML || "");
    };
  });

  function syncInputs() {
    appEl.querySelectorAll(".line-row").forEach((el) => {
      const r = findRow(el.dataset.key);
      if (!r) return;
      r.character = el.querySelector(".line-char").value;
      r.text = el.querySelector(".line-text").value;
    });
  }

  function moveBy(key, delta) {
    syncInputs();
    const order = activeKeys();
    const i = order.indexOf(key);
    const j = i + delta;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    // 以 order 重排 s.rows，待删除行保持在末尾
    const removed = s.rows.filter((r) => r.deleted);
    const kept = order.map((k) => findRow(k));
    s.rows = kept.concat(removed);
    drawEditor(document.getElementById("banner-slot")?.innerHTML || "");
  }

  document.getElementById("save-btn").onclick = () => saveEditor(syncInputs);
}

function targetRef(r) {
  return r.isNew ? { type: "new", cid: r.key } : { type: "line", id: r.id };
}

async function saveEditor(syncFn) {
  syncFn();
  const s = editorState;
  const active = s.rows.filter((r) => !r.deleted);

  // 前端基本校验
  for (const r of active) {
    if (!r.character.trim() || !r.text.trim()) {
      drawEditor(`<div class="banner error">每句台词都必须有角色和正文（${
        r.isNew ? "新增台词" : "台词 #" + r.id}）。</div>`);
      toast("有台词缺少角色或正文", true);
      return;
    }
  }

  // 需要服务端原始数据来生成差异
  let server;
  try {
    server = await api("GET", "/api/draft");
  } catch (e) { toast(e.message, true); return; }

  const oldMap = new Map(server.lines.map((l) => [`l${l.id}`, l]));
  const ops = [];
  let seq = 0;
  const cid = (t) => `${t}-${seq++}`;

  // 1) 删除
  for (const r of s.rows.filter((x) => x.deleted && !x.isNew)) {
    ops.push({ cid: cid("del"), type: "delete", target: targetRef(r) });
  }
  // 2) 改派（带笔记的真正跨角色改派会被服务端整次拒绝）
  for (const r of active.filter((x) => !x.isNew)) {
    const o = oldMap.get(r.key);
    if (o && r.character.trim() !== o.character)
      ops.push({ cid: cid("asg"), type: "assign", target: targetRef(r),
                 character: r.character.trim() });
  }
  // 3) 改词
  for (const r of active.filter((x) => !x.isNew)) {
    const o = oldMap.get(r.key);
    if (o && r.text.trim() !== o.text)
      ops.push({ cid: cid("txt"), type: "text", target: targetRef(r), text: r.text.trim() });
  }
  // 4) 新增：按最终顺序锚到「前一个仍存活的行」；开头且前面无行则 anchor=null。
  //    add 的 cid 必须就是新行键 r.key：后续 reorder / anchor 用 {type:"new", cid:r.key} 引用本批新行。
  for (const r of active) {
    if (!r.isNew) continue;
    const i = active.indexOf(r);
    const anchor = i > 0 ? targetRef(active[i - 1]) : null;
    ops.push({ cid: r.key, type: "add",
               character: r.character.trim(), text: r.text.trim(), anchor });
  }
  // 5) 重排：对所有现存行（含本批新增），按最终顺序与「服务端仍存活顺序」做差异，
  //    只给位置变化的行发 reorder；锚点引用新增行时用 new 引用。
  const survivingOldKeys = server.lines
    .filter((l) => !s.rows.find((x) => x.key === `l${l.id}` && x.deleted))
    .map((l) => `l${l.id}`);
  const finalKeys = active.map((r) => r.key);
  // 模拟前 4 步后的顺序：未删旧行按旧顺序，新增行此时在末尾（它们最终位置由 reorder/add 锚定）
  let simOrder = survivingOldKeys.slice();
  for (const k of finalKeys) if (!simOrder.includes(k)) simOrder.push(k);

  for (let i = 0; i < finalKeys.length; i++) {
    const key = finalKeys[i];
    const simI = simOrder.indexOf(key);
    if (simI === i) continue;
    const row = active[i];
    const anchorKey = i > 0 ? finalKeys[i - 1] : null;
    simOrder.splice(simI, 1);
    if (anchorKey === null) {
      simOrder.unshift(key);
    } else {
      simOrder.splice(simOrder.indexOf(anchorKey) + 1, 0, key);
    }
    ops.push({
      cid: cid("ord"), type: "reorder", target: targetRef(row),
      anchor: anchorKey === null ? null : targetRef(active[i - 1]),
    });
  }

  if (!ops.length) {
    toast("没有改动需要保存");
    return;
  }

  const btn = document.getElementById("save-btn");
  btn.disabled = true;
  try {
    const res = await api("POST", "/api/draft", { revision: s.revision, ops });
    toast(`已保存为修订 r${res.revision}`);
    await renderEditor();
  } catch (e) {
    btn.disabled = false;
    if (e.status === 409) {
      drawEditor(staleBanner(e) + '<p class="small"><a class="link" href="#/edit" onclick="location.reload()">点此刷新工作稿</a>（本地未保存的改动将丢失）</p>');
    } else if (e.status === 422 && e.data.error === "note_blocked") {
      drawEditor(noteBlockBanner(e.data.conflicts));
    } else {
      const details = (e.data.details || []).map((d) => `<li>${esc(d.message)}</li>`).join("");
      drawEditor(`<div class="banner error"><strong>保存被整次拒绝：</strong>${esc(e.message)}
        ${details ? `<ul>${details}</ul>` : ""}</div>`);
    }
  }
}

// ---------------------------------------------------------------- 角色页 -- //
// 待确认时，后端会带回「上次确认时所见」的快照，逐句标出当前页面与它的差异。
function diffTagsFor(entry, snapEntry, snapList, prevIdNow) {
  if (!snapList) return [];                  // 从未确认：没有对比基线
  if (!snapEntry) return ["新增"];
  const tags = [];
  if (snapEntry.text !== entry.text) tags.push("正文已改");
  const oldCue = snapEntry.cue, newCue = entry.cue;
  const cueChanged =
    (oldCue == null) !== (newCue == null) ||
    (oldCue && (oldCue.id !== newCue.id || oldCue.character !== newCue.character ||
                oldCue.text !== newCue.text));
  if (cueChanged) tags.push("紧前提示已变");
  const oldNote = snapEntry.note;
  const newNote = entry.note ? entry.note.content : null;
  if ((oldNote || null) !== (newNote || null)) {
    tags.push(oldNote ? (newNote ? "笔记已改" : "笔记已清空") : "新增了笔记");
  }
  const i = snapList.indexOf(snapEntry);
  const prevThen = i > 0 ? snapList[i - 1].lineId : null;
  if (prevThen !== prevIdNow) tags.push("顺序已变");
  return tags;
}

async function renderRole(name) {
  if (name === undefined || name === "") { appEl.innerHTML = '<p class="muted">缺少角色名。</p>'; return; }
  let data;
  try {
    data = await api("GET", `/api/characters/${encodeURI(name)}`);
  } catch (e) { renderError(e); return; }

  const conf = data.confirmation || { status: "pending" };
  const snapList = conf.snapshot || null;
  const snapById = snapList ? new Map(snapList.map((s) => [s.lineId, s])) : null;
  // 该角色提过的全部改词建议，按台词编号归组，直接挂在对应台词卡片下
  const suggByLine = new Map();
  for (const sg of data.suggestions || []) {
    if (!suggByLine.has(sg.lineId)) suggByLine.set(sg.lineId, []);
    suggByLine.get(sg.lineId).push(sg);
  }
  const suggestionStatus = { pending: ["待处理", "sugg-pend"], adopted: ["已采纳", "sugg-ok"], rejected: ["已驳回", "sugg-off"] };
  // 当前顺序中每句的前一句编号，用于判断「顺序已变」
  const prevIdNow = new Map();
  let prevId = null;
  for (const en of data.entries) { prevIdNow.set(en.lineId, prevId); prevId = en.lineId; }

  const entriesHtml = data.entries.map((en) => {
    let tagsHtml = "";
    if (snapById) {
      const tags = diffTagsFor(en, snapById.get(en.lineId), snapList, prevIdNow.get(en.lineId));
      if (tags.length) tagsHtml = tags.map((t) => `<span class="diff-tag">${esc(t)}</span>`).join("");
    }
    return `
    <div class="entry ${tagsHtml ? "has-diff" : ""}" data-id="${en.lineId}">
      <div class="line-tag">#${en.lineId}${tagsHtml}</div>
      ${en.cue
        ? `<p class="cue">紧前提示 · <span class="who">${esc(en.cue.character)}</span>
             <a class="link small" href="#/role/${encodeURIComponent(en.cue.character)}" title="打开该角色页">→</a>
             ：${esc(en.cue.text)}</p>`
        : '<p class="cue">（开场第一句，无前文提示）</p>'}
      <p class="line-text">${esc(en.text)}</p>
      <div class="note-box">
        <label>📝 我的排练笔记（随台词编号保存，重排、改词都不会丢）</label>
        <textarea rows="2" class="note-input" maxlength="2000"
          placeholder="给这句台词记一笔：停顿、走位、语气…">${esc(en.note ? en.note.content : "")}</textarea>
        <div class="row" style="margin-top:6px">
          <button class="primary icon note-save">保存笔记</button>
          ${en.note ? '<button class="ghost icon note-clear">清空笔记</button>' : ""}
          <span class="note-meta spacer">${en.note ? "更新于 " + fmtTime(en.note.updatedAt) : "还没有笔记"}</span>
        </div>
      </div>
      <div class="sugg-box">
        <label>💡 改词建议（提交后由编辑集中审阅，<strong>不会直接改动工作稿</strong>）</label>
        <textarea rows="2" class="sugg-input" maxlength="2000"
          placeholder="把这句想改成的正文写在这里，连同页面所见修订号一起提交给编辑"></textarea>
        <div class="row" style="margin-top:6px">
          <button class="primary icon sugg-submit">提交改词建议（r${data.revision}）</button>
          <span class="note-meta spacer">提交须带所见修订号，过期会被拒绝；提交不推进修订</span>
        </div>
        ${(suggByLine.get(en.lineId) || []).map((sg) => {
          const [label, cls] = suggestionStatus[sg.status] || [sg.status, "sugg-off"];
          return `<div class="sugg-item ${cls}">
            <span class="sugg-state">${esc(label)}</span>
            <span class="sugg-text">${esc(sg.proposedText)}</span>
            <span class="note-meta">
              提出于 r${sg.revision} · ${fmtTime(sg.createdAt)}
              ${sg.status === "adopted" ? `· ${esc(sg.decisionNote || "已采纳")}（${fmtTime(sg.decidedAt)}）` : ""}
              ${sg.status === "rejected" ? `· 已驳回（${fmtTime(sg.decidedAt)}）` : ""}
            </span>
          </div>`;
        }).join("")}
      </div>
    </div>`;
  }).join("");

  let confBanner;
  if (conf.status === "confirmed") {
    confBanner = `<div class="banner info">
      <strong>✔ 已确认</strong>：以上所见内容与 r${conf.confirmedRevision} 时确认的一致
      （${fmtTime(conf.confirmedAt)}）。其他页面的无关改动不会改变本状态。</div>`;
  } else if (conf.confirmedRevision != null) {
    const removed = snapList ? snapList.filter((s) =>
      !data.entries.some((en) => en.lineId === s.lineId)).map((s) => `#${s.lineId}`) : [];
    confBanner = `<div class="banner warn">
      <strong>⏳ 待确认</strong>：本角色页内容与 r${conf.confirmedRevision}
      确认时已不同（差异见各条标记${removed.length ? `；确认时的 ${removed.join("、")} 已不在本角色页` : ""}）。
      确认只对当前所见的 <strong>台词编号与顺序、正文、紧前提示和笔记</strong>有效，
      核对无误后点下方「确认本页所见内容」。</div>`;
  } else {
    confBanner = `<div class="banner warn">
      <strong>⏳ 待确认</strong>：你还没有确认过本角色页当前所见内容
      （台词编号与顺序、正文、紧前提示、笔记）。核对无误后点下方按钮确认。</div>`;
  }

  appEl.innerHTML = `
    <h1>角色页 · ${esc(name)}<span class="rev-badge">所见修订 r${data.revision}</span></h1>
    <p class="muted small">本页共 ${data.entries.length} 句。保存笔记会把工作稿推进一个修订；
      若期间别人改了稿，保存或确认会被拒绝并要求按新顺序刷新。
      发布后的冻结版见首页的已发布列表。</p>
    <div id="role-banner">${confBanner}</div>
    <div class="row" style="margin:4px 0 10px">
      <button class="primary" id="confirm-btn"
        title="提交页面所见修订号 r${data.revision}；过期会被拒绝">
        ✔ 确认本页所见内容（r${data.revision}）</button>
      <span class="small ${conf.status === "confirmed" ? "conf-ok" : "conf-pending"}"
        id="confirm-state">${
        conf.status === "confirmed"
          ? `当前状态：已确认 r${conf.confirmedRevision}`
          : (conf.confirmedRevision != null
              ? `当前状态：待确认（上次确认于 r${conf.confirmedRevision}）`
              : "当前状态：待确认")
      }</span>
    </div>
    ${entriesHtml}`;

  document.getElementById("confirm-btn").onclick = () => submitConfirmation(name, data.revision);

  appEl.querySelectorAll(".entry").forEach((box) => {
    const id = Number(box.dataset.id);
    const ta = box.querySelector(".note-input");
    const save = box.querySelector(".note-save");
    const clear = box.querySelector(".note-clear");
    save.onclick = async () => submitNote(id, name, ta.value, box, data.revision, false);
    if (clear) clear.onclick = () => {
      if (confirm("清空这句台词的笔记？")) submitNote(id, name, "", box, data.revision, true);
    };
    const sbtn = box.querySelector(".sugg-submit");
    const sta = box.querySelector(".sugg-input");
    sbtn.onclick = () => submitSuggestion(id, name, sta.value, data.revision);
  });
}

async function submitSuggestion(lineId, character, proposed, revision) {
  const text = (proposed || "").trim();
  const banner = document.getElementById("role-banner");
  if (!text) { toast("请先填写拟替换的正文", true); return; }
  try {
    await api("POST", `/api/lines/${lineId}/suggestions`,
              { revision, character, proposedText: text });
    toast("改词建议已提交，等待编辑审阅");
    // 提交不推进修订、不改稿；轻量重拉以展示建议状态并确认修订号仍有效
    renderRole(parseHash()[1]);
  } catch (e) {
    if (e.status === 409) {
      banner.innerHTML = staleBanner(e) +
        '<p class="small"><a class="link" href="" onclick="location.reload();return false;">刷新本页按最新所见内容重新提出</a></p>';
      banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      toast(e.message, true);
    }
  }
}

async function submitConfirmation(character, revision) {
  const btn = document.getElementById("confirm-btn");
  btn.disabled = true;
  try {
    await api("POST", `/api/characters/${encodeURI(character)}/confirmations`, { revision });
    toast("已确认本页所见内容");
    renderRole(parseHash()[1]);
  } catch (e) {
    btn.disabled = false;
    if (e.status === 409) {
      const banner = document.getElementById("role-banner");
      banner.innerHTML = staleBanner(e) +
        '<p class="small"><a class="link" href="" onclick="location.reload();return false;">刷新本页按最新内容重新确认</a></p>';
      banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      toast(e.message, true);
    }
  }
}

async function submitNote(lineId, character, content, box, revision, isClear) {
  const banner = document.getElementById("role-banner");
  try {
    const res = await api("PUT", `/api/lines/${lineId}/note`,
                          { revision, character, content: content.trim() });
    toast(isClear ? "笔记已清空" : "笔记已保存");
    // 成功后修订号已 +1：整页轻量重拉，确保页头修订、提示顺序、各卡片携带的修订号都是最新
    renderRole(parseHash()[1]);
  } catch (e) {
    if (e.status === 409) {
      banner.innerHTML = staleBanner(e) +
        '<p class="small"><a class="link" href="" onclick="location.reload();return false;">刷新本页查看新顺序</a></p>';
      banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else if (e.status === 422) {
      banner.innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
    } else {
      toast(e.message, true);
    }
  }
}

// ---------------------------------------------------------------- 改词审阅 //
let reviewState = null; // 最近一次拉取的建议列表（决策后整页重拉，保证修订/冲突状态最新）

async function renderReview() {
  appEl.innerHTML = '<p class="muted">加载中…</p>';
  let data;
  try {
    data = await api("GET", "/api/suggestions");
  } catch (e) { renderError(e); return; }
  reviewState = data;
  drawReview("");
}

function drawReview(bannerHtml) {
  const data = reviewState;
  const pending = data.suggestions.filter((s) => s.status === "pending");
  const decided = data.suggestions.filter((s) => s.status !== "pending");

  const col = (title, text, cls) => `
    <div class="sugg-col ${cls || ""}">
      <div class="sugg-col-title">${title}</div>
      <div class="sugg-col-body">${esc(text)}</div>
    </div>`;

  const pendingHtml = pending.map((sg) => {
    const cur = sg.current;
    const curText = cur
      ? `${cur.text}（现属 ${cur.character}）`
      : "（台词已从工作稿删除）";
    const conflict = sg.conflict;
    return `
    <div class="entry sugg-card ${conflict ? "has-diff" : ""}" data-id="${sg.id}">
      <div class="line-tag">建议 #${sg.id} · 台词 #${sg.lineId} ·
        <strong>${esc(sg.character)}</strong> 提出于 r${sg.revision} · ${fmtTime(sg.createdAt)}</div>
      <div class="sugg-grid">
        ${col("① 提出时原文", sg.originalText, "col-original")}
        ${col("② 当前正文", curText, conflict ? "col-conflict" : "col-current")}
        ${col("③ 拟替换正文", sg.proposedText, "col-proposed")}
      </div>
      ${conflict
        ? `<div class="banner error" style="margin-bottom:0">
             <strong>采纳冲突（${
               conflict.type === "line_deleted" ? "台词已删除"
               : conflict.type === "line_reassigned" ? "台词已改派" : "原文已变"}）：</strong>
             ${esc(conflict.message)}<br/>
             采纳会被拒绝且<strong>工作稿不变、建议保留</strong>；核对后可驳回，或请该角色重新提建议。
           </div>`
        : `<p class="muted small" style="margin:6px 0 0">台词未删除、未改派且原文一致：采纳将在同一事务内把正文替换为③、
          工作稿修订号推进 1，并把本建议标记为已采纳；其他台词或笔记的改动不影响采纳。</p>`}
      <div class="row" style="margin-top:10px">
        <button class="primary sugg-adopt" ${conflict ? "disabled" : ""}>✔ 采纳</button>
        <button class="danger ghost sugg-reject">✕ 驳回（只改变建议状态）</button>
      </div>
    </div>`;
  }).join("");

  const decidedLabel = { adopted: ["已采纳", "sugg-ok"], rejected: ["已驳回", "sugg-off"] };
  const decidedHtml = decided.map((sg) => {
    const [label, cls] = decidedLabel[sg.status] || [sg.status, ""];
    const cur = sg.current;
    const curCell = cur
      ? col("当前正文", `${cur.text}（现属 ${cur.character}）`, "col-current")
      : col("当前正文", "（台词已删除）", "col-conflict");
    return `
    <div class="sugg-done ${cls}">
      <span class="sugg-state">${esc(label)}</span>
      <span class="small"><strong>#${sg.id}</strong> · ${esc(sg.character)} 的台词 #${sg.lineId}
        · 提出于 r${sg.revision} · ${fmtTime(sg.decidedAt)}${
        sg.decisionNote ? " · " + esc(sg.decisionNote) : ""}</span>
      <details>
        <summary class="small muted">查看原文 / 当前正文 / 建议正文</summary>
        <div class="sugg-grid">
          ${col("提出时原文", sg.originalText, "col-original")}
          ${curCell}
          ${col("拟替换正文", sg.proposedText, "col-proposed")}
        </div>
      </details>
    </div>`;
  }).join("");

  appEl.innerHTML = `
    <h1>改词审阅<span class="rev-badge">当前修订 r${data.revision}</span>
      <span class="rev-badge">${pending.length} 条待处理</span></h1>
    <p class="muted small">角色在自己角色页提交的改词建议只记录不直接改稿：每条并排显示
      <strong>提出时原文、当前正文、拟替换正文</strong>。采纳才会改工作稿（修订号 +1）；
      台词已删除 / 改派 / 原文已变时不能采纳，会提示冲突并保留建议。
      建议及处理结果保存在数据库中，容器重启后仍可查看；旧发布版不受影响。</p>
    <div id="review-banner">${bannerHtml || ""}</div>

    <h2>待处理建议（${pending.length}）</h2>
    ${pendingHtml || '<div class="empty">没有待处理的改词建议。角色可在各自角色页（#/role/角色名）提交。</div>'}

    <h2>已处理（${decided.length}）</h2>
    ${decidedHtml ? `<div class="panel" style="padding:10px 14px">${decidedHtml}</div>`
      : '<p class="muted small">还没有已采纳或已驳回的建议。</p>'}`;

  appEl.querySelectorAll(".sugg-card").forEach((card) => {
    const id = Number(card.dataset.id);
    const adopt = card.querySelector(".sugg-adopt");
    const reject = card.querySelector(".sugg-reject");
    if (adopt) adopt.onclick = () => decideSuggestion(id, "adopt");
    reject.onclick = () => decideSuggestion(id, "reject");
  });
}

async function decideSuggestion(id, action) {
  const banner = document.getElementById("review-banner");
  if (action === "reject" &&
      !confirm(`驳回建议 #${id}？\n驳回只改变建议状态，不改动工作稿、不推进修订号。`)) return;
  if (action === "adopt" &&
      !confirm(`采纳建议 #${id}？\n将在同一事务内替换正文、工作稿修订号 +1，并标记建议为已采纳。`)) return;
  const btn = appEl.querySelector(`.sugg-card[data-id="${id}"] .sugg-${action}`);
  if (btn) btn.disabled = true;
  try {
    const res = await api("POST", `/api/suggestions/${id}/decisions`, { action });
    if (action === "adopt") {
      toast(`已采纳建议 #${id}：正文已替换，工作稿推进到 r${res.revision}`);
    } else {
      toast(`建议 #${id} 已驳回，工作稿未改动`);
    }
    // 采纳推进了修订、影响确认状态，整页重拉保证全部数据最新；驳回也走同一入口
    renderReview();
  } catch (e) {
    if (btn) btn.disabled = false;
    if (e.status === 409) {
      // 采纳冲突（删除 / 改派 / 原文已变）：工作稿未变、建议保留；重拉后展示冲突说明
      banner.innerHTML = `<div class="banner error"><strong>建议 #${id} 采纳被拒绝：</strong>${esc(e.message)}</div>`;
      banner.scrollIntoView({ behavior: "smooth", block: "nearest" });
      renderReviewKeepBanner(banner.innerHTML);
    } else if (e.status === 422) {
      banner.innerHTML = `<div class="banner error">${esc(e.message)}</div>`;
      renderReviewKeepBanner(banner.innerHTML);
    } else {
      toast(e.message, true);
    }
  }
}

async function renderReviewKeepBanner(bannerHtml) {
  try {
    reviewState = await api("GET", "/api/suggestions");
    drawReview(bannerHtml);
  } catch (e) { renderError(e); }
}

// ---------------------------------------------------------------- 已发布版 //
async function renderPub(rev) {
  let data;
  try {
    data = await api("GET", `/api/publications/${rev}`);
  } catch (e) { renderError(e); return; }

  const chars = data.characters.map((c) =>
    `<a class="chip" href="#/pub/${rev}/role/${encodeURIComponent(c)}">${esc(c)}角色页</a>`).join("");

  const html = data.lines.map((l) => `
    <div class="entry" style="padding:12px 16px">
      <div class="line-tag">#${l.id} · ${esc(l.character)}
        ${l.note ? '<span class="note-flag">冻结笔记</span>' : ""}</div>
      <p class="line-text" style="margin:4px 0 0">${esc(l.text)}</p>
      ${l.note ? `<div class="note-readonly" style="margin-top:8px">📝 ${esc(l.note.content)}</div>` : ""}
    </div>`).join("");

  appEl.innerHTML = `
    <h1>已发布版 r${data.revision}<span class="rev-badge frozen">冻结快照</span></h1>
    <p class="muted small">${esc(data.label || "未命名版本")} · 发布于 ${fmtTime(data.createdAt)}
      · 此后工作稿的任何修改都不影响本页。</p>
    <div class="panel row">${chars}</div>
    ${html || '<div class="empty">该版本没有台词。</div>'}
    <p style="margin-top:20px"><a class="link" href="#/">← 返回首页 / 查看其它版本</a></p>`;
}

async function renderPubRole(rev, name) {
  let data;
  try {
    data = await api("GET", `/api/publications/${rev}/characters/${encodeURIComponent(name)}`);
  } catch (e) { renderError(e); return; }

  const entriesHtml = data.entries.map((en) => `
    <div class="entry">
      <div class="line-tag">#${en.lineId}</div>
      ${en.cue
        ? `<p class="cue">紧前提示 · <span class="who">${esc(en.cue.character)}</span>：${esc(en.cue.text)}</p>`
        : '<p class="cue">（开场第一句，无前文提示）</p>'}
      <p class="line-text">${esc(en.text)}</p>
      ${en.note
        ? `<div class="note-box"><label>📝 冻结于 r${rev} 的笔记（只读）</label>
           <div class="note-readonly">${esc(en.note.content)}</div>
           <div class="note-meta">保存于 ${fmtTime(en.note.updatedAt)}</div></div>`
        : '<p class="note-meta">发布时该句没有笔记</p>'}
    </div>`).join("");

  appEl.innerHTML = `
    <h1>${esc(name)} · 已发布版 r${rev}<span class="rev-badge frozen">冻结快照</span></h1>
    <p class="muted small">${esc(data.label || "")} · 台词顺序、紧前提示与笔记全部冻结；
      <a class="link" href="#/role/${encodeURIComponent(name)}">查看当前工作稿角色页</a> ·
      <a class="link" href="#/pub/${rev}">查看本版全剧</a></p>
    ${entriesHtml}`;
}

// ---------------------------------------------------------------- 启动 ---- //
navigate();
