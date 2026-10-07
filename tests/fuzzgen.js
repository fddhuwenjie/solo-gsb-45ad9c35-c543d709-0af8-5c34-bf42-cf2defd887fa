/* Fuzz：生成随机编辑场景的 ops（算法与 static/app.js 中 saveEditor 的第 4/5 步严格一致）。
 * 输出 JSON: [{ initial: [{id,character,text}], final: [{id?null,character,text}], ops }]
 */
"use strict";

function targetRef(r) {
  return r.id == null ? { type: "new", cid: r.key } : { type: "line", id: r.id };
}

// 与 app.js saveEditor 相同的差异生成逻辑
function buildOps(initial, finalRows /* [{key,id,isNew,character,text,deleted}] */, survivingOldServerLines) {
  const ops = [];
  let seq = 0;
  const cid = (t) => `${t}-${seq++}`;
  const active = finalRows.filter((r) => !r.deleted);

  for (const r of finalRows.filter((x) => x.deleted && !x.isNew))
    ops.push({ cid: cid("del"), type: "delete", target: targetRef(r) });

  const oldMap = new Map(survivingOldServerLines.map((l) => [`l${l.id}`, l]));
  for (const r of active.filter((x) => !x.isNew)) {
    const o = oldMap.get(r.key);
    if (o && r.character.trim() !== o.character)
      ops.push({ cid: cid("asg"), type: "assign", target: targetRef(r), character: r.character.trim() });
  }
  for (const r of active.filter((x) => !x.isNew)) {
    const o = oldMap.get(r.key);
    if (o && r.text.trim() !== o.text)
      ops.push({ cid: cid("txt"), type: "text", target: targetRef(r), text: r.text.trim() });
  }
  for (const r of active) {
    if (!r.isNew) continue;
    const i = active.indexOf(r);
    const anchor = i > 0 ? targetRef(active[i - 1]) : null;
    // add 的 cid 必须就是新行键 r.key（与 static/app.js 一致）
    ops.push({ cid: r.key, type: "add", character: r.character.trim(), text: r.text.trim(), anchor });
  }

  const survivingOldKeys = survivingOldServerLines
    .filter((l) => !finalRows.find((x) => x.key === `l${l.id}` && x.deleted))
    .map((l) => `l${l.id}`);
  const finalKeys = active.map((r) => r.key);
  let simOrder = survivingOldKeys.slice();
  for (const k of finalKeys) if (!simOrder.includes(k)) simOrder.push(k);

  for (let i = 0; i < finalKeys.length; i++) {
    const key = finalKeys[i];
    const simI = simOrder.indexOf(key);
    if (simI === i) continue;
    const row = active[i];
    const anchorKey = i > 0 ? finalKeys[i - 1] : null;
    simOrder.splice(simI, 1);
    if (anchorKey === null) simOrder.unshift(key);
    else simOrder.splice(simOrder.indexOf(anchorKey) + 1, 0, key);
    ops.push({
      cid: cid("ord"), type: "reorder", target: targetRef(row),
      anchor: anchorKey === null ? null : targetRef(active[i - 1]),
    });
  }
  return ops;
}

// ---------------- 随机编辑模型 ----------------
const CHARS = ["甲", "乙", "丙", "丁"];
function rnd(n) { return Math.floor(Math.random() * n); }
function pick(arr) { return arr[rnd(arr.length)]; }

function scenario() {
  // 初始 0..8 行
  const n = rnd(9);
  let nextId = 1;
  let rows = [];
  const initial = [];
  for (let i = 0; i < n; i++) {
    const id = nextId++;
    const r = { key: `l${id}`, id, isNew: false, character: pick(CHARS),
                text: `句${id}-${rnd(1000)}`, deleted: false };
    rows.push(r);
    initial.push({ id, character: r.character, text: r.text });
  }

  // 随机 1..8 步编辑
  const steps = 1 + rnd(8);
  for (let s = 0; s < steps; s++) {
    const live = rows.filter((r) => !r.deleted);
    const kind = rnd(5);
    if (kind === 0 && live.length) { // 删除
      live[rnd(live.length)].deleted = true;
    } else if (kind === 1 && live.length) { // 改派
      const r = pick(live);
      r.character = pick(CHARS);
    } else if (kind === 2 && live.length) { // 改词
      const r = pick(live);
      r.text = `改${rnd(10000)}`;
    } else if (kind === 3) { // 新增
      const nr = { key: `new-${s}-${rnd(1e6)}`, id: null, isNew: true,
                   character: pick(CHARS), text: `新${s}-${rnd(1000)}`, deleted: false };
      if (!live.length || rnd(2) === 0) rows.unshift(nr);
      else rows.splice(rows.indexOf(pick(live)) + 1, 0, nr);
    } else if (live.length > 1) { // 重排
      const r = pick(live);
      const from = rows.indexOf(r);
      rows.splice(from, 1);
      const to = rnd(rows.filter((x) => !x.deleted).length + 1);
      // 插到第 to 个存活位置
      let inserted = false, cnt = 0;
      for (let i = 0; i <= rows.length; i++) {
        if (cnt === to) { rows.splice(i, 0, r); inserted = true; break; }
        if (i < rows.length && !rows[i].deleted) cnt++;
      }
      if (!inserted) rows.push(r);
    }
  }

  // 至少要有一点改动，且新行文本/角色都合法（生成器保证）
  const finalRows = rows;
  const final = finalRows.filter((r) => !r.deleted).map((r) => ({
    id: r.id, character: r.character, text: r.text,
  }));
  const serverLines = initial.map((l) => ({ id: l.id, character: l.character, text: l.text }));
  const ops = buildOps(initial, finalRows, serverLines);
  return { initial, final, ops };
}

const N = Number(process.argv[2] || 2000);
const out = [];
for (let i = 0; i < N; i++) {
  const sc = scenario();
  if (sc.ops.length) out.push(sc);
}
process.stdout.write(JSON.stringify(out));
