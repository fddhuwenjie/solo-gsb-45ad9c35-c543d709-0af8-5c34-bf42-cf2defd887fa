"""端到端冒烟测试：用 Flask test client 在临时库上跑完所有业务规则。
运行：PYTHONPATH=<site-packages> python3 smoke_test.py
"""
import os
import sys
import tempfile

os.environ["SCRIPT_DB"] = os.path.join(tempfile.mkdtemp(prefix="reh-"), "test.db")

import app as appmod

appmod.init_db()
client = appmod.app.test_client()

passed = []
def check(name, cond, extra=""):
    if not cond:
        print(f"FAIL: {name} {extra}")
        sys.exit(1)
    passed.append(name)

# 1. 初始工作稿
r = client.get("/api/draft").get_json()
check("seed revision=1", r["revision"] == 1, r["revision"])
check("seed 7 lines", len(r["lines"]) == 7, len(r["lines"]))
check("first cue is None", r["lines"][0]["cue"] is None)
check("cue = previous line", r["lines"][1]["cue"]["id"] == r["lines"][0]["id"])
check("seed note on #7", r["lines"][6]["note"] is not None
      and "停两拍" in r["lines"][6]["note"]["content"])
seed_ids = [l["id"] for l in r["lines"]]

# 角色确认：示例三个角色在 r1 均已确认（随 r1 一起播种）
r = client.get("/api/confirmations").get_json()
check("seed all confirmed at r1",
      [(c["character"], c["status"]) for c in r["confirmations"]] ==
      [("林晚", "confirmed"), ("老周", "confirmed"), ("阿禾", "confirmed")]
      and all(c["confirmedRevision"] == 1 for c in r["confirmations"]), r)

# 角色页
r = client.get("/api/characters/林晚").get_json()
check("role page revision", r["revision"] == 1)
check("role only own lines", all(e is not None for e in r["entries"])
      and len(r["entries"]) == 3)
check("role cue previous speaker", r["entries"][0]["cue"] is None
      and r["entries"][1]["cue"]["character"] == "阿禾")
check("role page carries confirmation",
      r["confirmation"]["status"] == "confirmed"
      and r["confirmation"]["confirmedRevision"] == 1, r["confirmation"])
check("missing role 404", client.get("/api/characters/路人").status_code == 404)

# 已发布 r1
r = client.get("/api/publications").get_json()
check("pub list has r1", [p["revision"] for p in r["publications"]] == [1])
r = client.get("/api/publications/1").get_json()
check("pub r1 7 lines", len(r["lines"]) == 7)
check("pub r1 note frozen", r["lines"][6]["note"] is not None)
check("pub missing 404", client.get("/api/publications/99").status_code == 404)

# 2. 过期修订整次拒绝
resp = client.post("/api/draft", json={"revision": 0, "ops": [
    {"cid": "a", "type": "text", "target": {"type": "line", "id": seed_ids[0]},
     "text": "改了"}]})
check("stale draft -> 409", resp.status_code == 409, resp.status_code)
r = client.get("/api/draft").get_json()
check("stale changed nothing", r["revision"] == 1 and r["lines"][0]["id"] == seed_ids[0])

# 3. 改词：成功，修订 1->2，编号/笔记不变
resp = client.post("/api/draft", json={"revision": 1, "ops": [
    {"cid": "t1", "type": "text", "target": {"type": "line", "id": seed_ids[0]},
     "text": "（提着两盏马灯）老周，河面上那灯，是你挂的吗？"}]})
check("text edit 200", resp.status_code == 200, resp.get_json())
check("rev bumped to 2", resp.get_json()["revision"] == 2)
r = client.get("/api/draft").get_json()
check("text actually changed", "两盏马灯" in r["lines"][0]["text"])
check("id unchanged after text edit", [l["id"] for l in r["lines"]] == seed_ids)
check("note still on #7", r["lines"][6]["note"] is not None)

# r1 发布版不受影响
r = client.get("/api/publications/1").get_json()
check("pub r1 unaffected", "一盏马灯" in r["lines"][0]["text"])

# 确认状态：改了林晚的第一句 -> 林晚（正文变）、老周（#2 的紧前提示变）待确认，
# 阿禾所见内容完全不受影响，仍是已确认
r = client.get("/api/confirmations").get_json()
st = {c["character"]: c["status"] for c in r["confirmations"]}
check("text edit: 林晚 pending", st["林晚"] == "pending", st)
check("text edit: 老周 cue pending", st["老周"] == "pending", st)
check("text edit: 阿禾 stays confirmed", st["阿禾"] == "confirmed", st)
# 待确认角色带回确认时所见快照（旧正文），已确认角色不带快照
lin = [c for c in r["confirmations"] if c["character"] == "林晚"][0]
check("pending snapshot has old content",
      lin["snapshot"] is not None and "提着一盏马灯" in lin["snapshot"][0]["text"]
      and lin["confirmedRevision"] == 1, lin)
ahe = [c for c in r["confirmations"] if c["character"] == "阿禾"][0]
check("confirmed snapshot omitted", ahe["snapshot"] is None)
# 过期修订确认被拒；角色不存在 404；缺 revision 400
check("stale confirm -> 409",
      client.post("/api/characters/林晚/confirmations", json={"revision": 1}).status_code == 409)
check("confirm unknown character -> 404",
      client.post("/api/characters/路人/confirmations", json={"revision": 2}).status_code == 404)
check("confirm without revision -> 400",
      client.post("/api/characters/林晚/confirmations", json={}).status_code == 400)
# 按当前修订确认 -> 201，且确认本身不推进修订号
resp = client.post("/api/characters/林晚/confirmations", json={"revision": 2})
check("confirm 201", resp.status_code == 201, resp.get_json())
check("confirm does not bump revision",
      client.get("/api/draft").get_json()["revision"] == 2)
# 再确认一次阿禾（内容没变，属于重复确认同样允许）
check("re-confirm unchanged role 201",
      client.post("/api/characters/阿禾/confirmations", json={"revision": 2}).status_code == 201)

# 4. 删除带笔记的台词 -> 整次拒绝 422，指出笔记
resp = client.post("/api/draft", json={"revision": 2, "ops": [
    {"cid": "d1", "type": "delete", "target": {"type": "line", "id": seed_ids[6]}}]})
check("delete noted line -> 422", resp.status_code == 422, resp.status_code)
body = resp.get_json()
check("conflict names line/character",
      body["conflicts"][0]["lineId"] == seed_ids[6]
      and body["conflicts"][0]["character"] == "林晚", body)
r = client.get("/api/draft").get_json()
check("rejected delete keeps line", len(r["lines"]) == 7 and r["revision"] == 2)

# 5. 改派带笔记的台词 -> 整次拒绝
resp = client.post("/api/draft", json={"revision": 2, "ops": [
    {"cid": "g1", "type": "assign", "target": {"type": "line", "id": seed_ids[6]},
     "character": "阿禾"}]})
check("assign noted line -> 422", resp.status_code == 422, resp.status_code)
check("assign conflict says new char",
      resp.get_json()["conflicts"][0]["newCharacter"] == "阿禾")

# 改派没有笔记的台词 -> 成功（重算提示时角色跟着词走）
resp = client.post("/api/draft", json={"revision": 2, "ops": [
    {"cid": "g2", "type": "assign", "target": {"type": "line", "id": seed_ids[0]},
     "character": "旁白"}]})
check("assign clean line 200", resp.status_code == 200, resp.get_json())
check("rev -> 3", resp.get_json()["revision"] == 3)
r = client.get("/api/characters/旁白").get_json()
check("new role page works", len(r["entries"]) == 1)

# 6. 批量：新增两句 + 删除无笔记的旧句 + 重排，整批一个修订；
#    并在同一批里把新台词作为后续 reorder 的锚点（前端也是这样生成操作的）
resp = client.post("/api/draft", json={"revision": 3, "ops": [
    {"cid": "add1", "type": "add", "character": "阿禾", "text": "新句 A（本批新增，随后被移动）",
     "anchor": None},
    {"cid": "add2", "type": "add", "character": "老周", "text": "新句 B（重排锚到本批新增的 A 之后）",
     "anchor": {"type": "new", "cid": "add1"}},
    {"cid": "del1", "type": "delete", "target": {"type": "line", "id": seed_ids[1]}},
    {"cid": "ord1", "type": "reorder", "target": {"type": "new", "cid": "add1"},
     "anchor": {"type": "line", "id": seed_ids[2]}},
    {"cid": "ord2", "type": "reorder", "target": {"type": "new", "cid": "add2"},
     "anchor": {"type": "new", "cid": "add1"}},
]})
check("batch 200", resp.status_code == 200, (resp.status_code, resp.get_json()))
new_ids = resp.get_json()["newIds"]
check("new ids returned", set(new_ids) == {"add1", "add2"}, new_ids)
check("rev -> 4", resp.get_json()["revision"] == 4)
r = client.get("/api/draft").get_json()
# 最终顺序：#1 旁白, #3 阿禾, A 阿禾, B 老周, #4, #5, #6, #7
pos = {l["id"]: i for i, l in enumerate(r["lines"])}
idA, idB = new_ids["add1"], new_ids["add2"]
check("add1 right after #3", pos[seed_ids[2]] == 1 and pos[idA] == 2, pos)
check("add2 right after add1", pos[idB] == pos[idA] + 1)
check("old #2 deleted", seed_ids[1] not in pos)
# 删除后编号不复用：再新增一句，编号必须更大
resp = client.post("/api/draft", json={"revision": 4, "ops": [
    {"cid": "add3", "type": "add", "character": "老周", "text": "新句 C",
     "anchor": None}]})
idC = resp.get_json()["newIds"]["add3"]
check("ids never reused", idC > max(seed_ids) and idC > idB and idC != seed_ids[1], idC)
check("rev -> 5", resp.get_json()["revision"] == 5)

# 提示随顺序重算
r = client.get("/api/draft").get_json()
check("cue recomputed after reorder",
      r["lines"][pos[idB]]["cue"]["id"] == idA)

# 7. 结构错误整批回滚：引用不存在的锚点，且同批有合法改动 -> 全不生效
resp = client.post("/api/draft", json={"revision": 5, "ops": [
    {"cid": "x1", "type": "text", "target": {"type": "line", "id": seed_ids[2]},
     "text": "这条合法改动也必须回滚"},
    {"cid": "x2", "type": "reorder", "target": {"type": "line", "id": seed_ids[2]},
     "anchor": {"type": "line", "id": 999999}},
]})
check("structural error -> 400", resp.status_code == 400, resp.status_code)
r = client.get("/api/draft").get_json()
check("rollback: rev still 5", r["revision"] == 5)
check("rollback: text untouched",
      all(l["id"] != seed_ids[2] or "回滚" not in l["text"] for l in r["lines"]))

# 8. 笔记：过期修订拒绝
resp = client.put(f"/api/lines/{seed_ids[6]}/note",
                  json={"revision": 1, "character": "林晚", "content": "过期保存"})
check("stale note -> 409", resp.status_code == 409, resp.status_code)

# 合法保存笔记 -> 修订 +1
resp = client.put(f"/api/lines/{seed_ids[6]}/note",
                  json={"revision": 5, "character": "林晚", "content": "更新后的笔记：灯亮三秒再开口"})
check("note save 200", resp.status_code == 200, resp.get_json())
check("note save bumps rev -> 6", resp.get_json()["revision"] == 6)
r = client.get("/api/characters/林晚").get_json()
note7 = [e for e in r["entries"] if e["lineId"] == seed_ids[6]][0]["note"]
check("note content updated", note7 and "灯亮三秒" in note7["content"])

# 清空笔记
resp = client.put(f"/api/lines/{seed_ids[6]}/note",
                  json={"revision": 6, "character": "林晚", "content": ""})
check("note clear -> 7", resp.get_json()["revision"] == 7)
r = client.get("/api/characters/林晚").get_json()
check("note cleared", [e for e in r["entries"] if e["lineId"] == seed_ids[6]][0]["note"] is None)

# 清空后删除该台词 -> 成功
resp = client.post("/api/draft", json={"revision": 7, "ops": [
    {"cid": "d2", "type": "delete", "target": {"type": "line", "id": seed_ids[6]}}]})
check("delete after note cleared 200", resp.status_code == 200, resp.get_json())
check("rev -> 8", resp.get_json()["revision"] == 8)

# 9. 发布闸门：有待确认角色 -> 422 整次拒绝，且不留下任何（部分）发布版
r = client.get("/api/confirmations").get_json()
pending_now = {c["character"] for c in r["confirmations"] if c["status"] != "confirmed"}
check("four current characters at rev8",
      pending_now == {"旁白", "林晚", "老周", "阿禾"}, pending_now)
resp = client.post("/api/publications", json={"revision": 8, "label": "不该出现的版本"})
check("publish with pending -> 422", resp.status_code == 422, resp.status_code)
check("publish rejection lists characters",
      set(resp.get_json()["pendingCharacters"]) == pending_now, resp.get_json())
check("rejected publish leaves no snapshot",
      [p["revision"] for p in client.get("/api/publications").get_json()["publications"]] == [1])

# 逐个确认当前四个角色（确认不推进修订）；缺一个仍不能发布
for name in ["林晚", "老周", "阿禾"]:
    check(f"confirm {name} at rev8",
          client.post(f"/api/characters/{name}/confirmations",
                      json={"revision": 8}).status_code == 201)
resp = client.post("/api/publications", json={"revision": 8})
check("publish still blocked with one pending", resp.status_code == 422)
check("last pending character named",
      resp.get_json()["pendingCharacters"] == ["旁白"], resp.get_json())
check("confirm still no revision bump",
      client.get("/api/draft").get_json()["revision"] == 8)
check("confirm last character 旁白",
      client.post("/api/characters/旁白/confirmations", json={"revision": 8}).status_code == 201)

# 记录 r8 确认时阿禾 / 老周各句的紧前提示，供后续「无关改动」隔离比对
def cues_of(name):
    return [(e["lineId"], e["cue"]["id"] if e["cue"] else None)
            for e in client.get(f"/api/characters/{name}").get_json()["entries"]]
cues_at_rev8 = {"阿禾": cues_of("阿禾"), "老周": cues_of("老周")}

# 发布 r8（当前修订 8）；之后再改工作稿，r8 不变
pub = client.post("/api/publications", json={"revision": 8, "label": "联排版"}).get_json()
check("publish r8", pub["revision"] == 8)
check("duplicate publish 422",
      client.post("/api/publications", json={"revision": 8}).status_code == 422)
check("publish stale 409",
      client.post("/api/publications", json={"revision": 7}).status_code == 409)

# 发布后继续改工作稿
resp = client.post("/api/draft", json={"revision": 8, "ops": [
    {"cid": "z1", "type": "add", "character": "旁白", "text": "发布之后才加的收场白",
     "anchor": None}]})
id_after = resp.get_json()["newIds"]["z1"]
r = client.get("/api/publications/8").get_json()
check("frozen r8 unaffected by later edit",
      all(l["id"] != id_after for l in r["lines"]) and len(r["lines"]) >= 6)
r = client.get("/api/draft").get_json()
check("draft has later edit", any(l["id"] == id_after for l in r["lines"]))
# 旧版 r1 仍可打开，且冻结着旧笔记
r1 = client.get("/api/publications/1").get_json()
check("r1 still open with original 7 + note",
      len(r1["lines"]) == 7 and r1["lines"][6]["note"] is not None
      and "停两拍" in r1["lines"][6]["note"]["content"])
# 已发布角色页
r = client.get("/api/publications/1/characters/林晚").get_json()
check("pub role page frozen notes",
      any(e["lineId"] == seed_ids[6] and e["note"] for e in r["entries"]))

# 无关改动不影响已确认：新增的收场白属于旁白，只有旁白的角色页多了一句
# （确认时它不存在）；其余角色所见完全不变，仍保持已确认
r = client.get("/api/confirmations").get_json()
st = {c["character"]: c["status"] for c in r["confirmations"]}
check("isolation: only line-owner role pending",
      st == {"旁白": "pending", "林晚": "confirmed", "老周": "confirmed",
             "阿禾": "confirmed"}, st)
# 角色页：新句在当前页里，但确认时快照中没有它（新增可见台词）
r = client.get("/api/characters/旁白").get_json()
check("new line visible now", any(e["lineId"] == id_after for e in r["entries"]))
check("new line absent from confirmed snapshot",
      all(s["lineId"] != id_after for s in r["confirmation"]["snapshot"]))
check("old line #1 still in snapshot as before",
      any(s["lineId"] == seed_ids[0] and s["cue"] is None
          for s in r["confirmation"]["snapshot"]))
check("confirm endpoint stale after new edit still 409",
      client.post("/api/characters/旁白/confirmations", json={"revision": 8}).status_code == 409)

# 确认状态持久化：重新 init_db（容器重启等价）后确认记录仍在（此时仍处 r9）
appmod.init_db()
r = client.get("/api/confirmations").get_json()
st = {c["character"]: c["status"] for c in r["confirmations"]}
check("confirmations survive restart",
      st == {"旁白": "pending", "林晚": "confirmed", "老周": "confirmed",
             "阿禾": "confirmed"}, st)
r = client.get("/api/publications").get_json()
check("pubs survive restart", [p["revision"] for p in r["publications"]] == [1, 8])

# 紧前提示隔离：旁白在 r9 重新确认，随后在开头插入一句新开场白（add + reorder，
# 与前端算法一致）-> 旁白第一句 #1 原本开场、紧前提示变为新句，待确认；
# 新句属于林晚，林晚也待确认；阿禾第一句 #3 的紧前提示始终是 #1，老周第一句
# 紧前提示始终是 #4，两人所见内容均未变化，保持已确认
check("confirm 旁白 at rev9",
      client.post("/api/characters/旁白/confirmations", json={"revision": 9}).status_code == 201)
resp = client.post("/api/draft", json={"revision": 9, "ops": [
    {"cid": "open1", "type": "add", "character": "林晚", "text": "新的开场白",
     "anchor": None},
    {"cid": "open2", "type": "reorder", "target": {"type": "new", "cid": "open1"},
     "anchor": None},
]})
check("insert top add+reorder 200", resp.status_code == 200, resp.get_json())
id_open = resp.get_json()["newIds"]["open1"]
r = client.get("/api/draft").get_json()
check("new opening is first", r["lines"][0]["id"] == id_open, r["lines"][0])
st = {c["character"]: c["status"] for c in
      client.get("/api/confirmations").get_json()["confirmations"]}
check("cue isolation: only 旁白/林晚 pending",
      st == {"旁白": "pending", "林晚": "pending", "老周": "confirmed",
             "阿禾": "confirmed"}, st)
# 旁白角色页明确标出 #1 的紧前提示从「无」变成新开场白
r = client.get("/api/characters/旁白").get_json()
e1 = next(e for e in r["entries"] if e["lineId"] == seed_ids[0])
check("旁白 #1 cue now the new opening", e1["cue"] is not None
      and e1["cue"]["id"] == id_open, e1)
s1 = next(s for s in r["confirmation"]["snapshot"] if s["lineId"] == seed_ids[0])
check("旁白 #1 snapshot cue was None", s1["cue"] is None)
# 阿禾、老周在 r10 仍已确认：记录 r8 确认后他们各句的紧前提示，开头插句后逐一比对不变
for who in ("阿禾", "老周"):
    r = client.get(f"/api/characters/{who}").get_json()
    check(f"{who} confirmed after top insert",
          r["confirmation"]["status"] == "confirmed", who)
    cues_now = [(e["lineId"], e["cue"]["id"] if e["cue"] else None) for e in r["entries"]]
    check(f"{who} cues unchanged by top insert", cues_now == cues_at_rev8[who],
          (cues_now, cues_at_rev8[who]))

# 10. 列表汇总
r = client.get("/api/publications").get_json()
check("pub list r1,r8", [p["revision"] for p in r["publications"]] == [1, 8])
check("working rev 10", r["workingRevision"] == 10)

# --------------------------------------------------------------------------- #
# 10b. 改词建议：角色在角色页提交（带所见修订号、不直接改稿），编辑集中审阅
# --------------------------------------------------------------------------- #
# 工作稿重建：从空稿开始，干净地验证建议全流程（旧发布版 r1/r8 保持原样）
d = client.get("/api/draft").get_json()
while d["lines"]:
    nr = d["revision"]
    lid = d["lines"][0]["id"]
    owner = d["lines"][0]["character"]
    e0 = client.get(f"/api/characters/{owner}").get_json()["entries"][0]
    if e0["lineId"] == lid and e0["note"]:
        client.put(f"/api/lines/{lid}/note",
                  json={"revision": nr, "character": owner, "content": ""})
        nr += 1
    client.post("/api/draft", json={"revision": nr, "ops": [
        {"cid": "drain", "type": "delete",
         "target": {"type": "line", "id": lid}}]})
    d = client.get("/api/draft").get_json()

base_rev = client.get("/api/draft").get_json()["revision"]
resp = client.post("/api/draft", json={"revision": base_rev, "ops": [
    {"cid": "b1", "type": "add", "character": "林晚", "text": "林晚原句", "anchor": None},
    {"cid": "b2", "type": "add", "character": "老周", "text": "老周原句",
     "anchor": {"type": "new", "cid": "b1"}},
    {"cid": "b3", "type": "add", "character": "阿禾", "text": "阿禾原句",
     "anchor": {"type": "new", "cid": "b2"}},
    {"cid": "b4", "type": "add", "character": "阿禾", "text": "阿禾第二句",
     "anchor": {"type": "new", "cid": "b3"}},
]})
R0 = resp.get_json()["revision"]
ids = {l["character"]: l["id"] for l in client.get("/api/draft").get_json()["lines"]}
id_lw, id_lz_ = ids["林晚"], ids["老周"]
# 阿禾有两句，按顺序取
ah_lines = [l["id"] for l in client.get("/api/draft").get_json()["lines"] if l["character"] == "阿禾"]
id_ah1, id_ah2 = ah_lines[0], ah_lines[1]

# 提交建议的参数校验
check("sugg missing revision -> 400", client.post(
    f"/api/lines/{id_lw}/suggestions", json={"character": "林晚", "proposedText": "x"}).status_code == 400)
check("sugg missing text -> 400", client.post(
    f"/api/lines/{id_lw}/suggestions", json={"revision": R0, "character": "林晚"}).status_code == 400)
check("sugg blank text -> 400", client.post(
    f"/api/lines/{id_lw}/suggestions",
    json={"revision": R0, "character": "林晚", "proposedText": "   "}).status_code == 400)
# 过期修订号 -> 409，建议未提交
check("sugg stale revision -> 409", client.post(
    f"/api/lines/{id_lw}/suggestions",
    json={"revision": R0 - 1, "character": "林晚", "proposedText": "过期"}).status_code == 409)
# 台词不存在 -> 404
check("sugg missing line -> 404", client.post(
    "/api/lines/999999/suggestions",
    json={"revision": R0, "character": "林晚", "proposedText": "x"}).status_code == 404)
# 角色不匹配（不能替别的角色提） -> 422
check("sugg other character -> 422", client.post(
    f"/api/lines/{id_lw}/suggestions",
    json={"revision": R0, "character": "老周", "proposedText": "替林晚改"}).status_code == 422)
# 与原文相同 -> 422
check("sugg no change -> 422", client.post(
    f"/api/lines/{id_lw}/suggestions",
    json={"revision": R0, "character": "林晚", "proposedText": "林晚原句"}).status_code == 422)

# 四条建议：S1 正常采纳；S2 提出后正文被改（冲突）；S3 提出后台词被删（冲突）；
# S4 提出后被改派（冲突）；其中 S4 的驳回用来验证驳回不挑冲突
resp = client.post(f"/api/lines/{id_lw}/suggestions", json={
    "revision": R0, "character": "林晚", "proposedText": "林晚建议句"})
check("S1 create 201", resp.status_code == 201, resp.get_json())
S1 = resp.get_json()["id"]
check("S1 records baseline", S1 and resp.get_json()["lineId"] == id_lw
      and resp.get_json()["character"] == "林晚"
      and resp.get_json()["originalText"] == "林晚原句"
      and resp.get_json()["revision"] == R0
      and resp.get_json()["status"] == "pending", resp.get_json())
resp = client.post(f"/api/lines/{id_lz_}/suggestions", json={
    "revision": R0, "character": "老周", "proposedText": "老周建议句"})
S2 = resp.get_json()["id"]
resp = client.post(f"/api/lines/{id_ah1}/suggestions", json={
    "revision": R0, "character": "阿禾", "proposedText": "阿禾建议句一"})
S3 = resp.get_json()["id"]
resp = client.post(f"/api/lines/{id_ah2}/suggestions", json={
    "revision": R0, "character": "阿禾", "proposedText": "阿禾建议句二"})
S4 = resp.get_json()["id"]

# 提交建议不改稿、不推进修订号
check("suggestions do not bump revision",
      client.get("/api/draft").get_json()["revision"] == R0)

# 角色页带回本角色的建议
r = client.get("/api/characters/阿禾").get_json()
check("role page lists own suggestions",
      sorted(sg["id"] for sg in r["suggestions"]) == sorted([S3, S4])
      and all(sg["character"] == "阿禾" for sg in r["suggestions"]),
      r["suggestions"])
check("other role does not see suggestions",
      client.get("/api/characters/林晚").get_json()["suggestions"][0]["id"] == S1)

# 审阅清单：4 条待处理，携带原文/当前正文/冲突信息
r = client.get("/api/suggestions").get_json()
check("suggestion list revision+count", r["revision"] == R0 and r["pendingCount"] == 4, r)
by_id = {s["id"]: s for s in r["suggestions"]}
check("suggestion carries current + no conflict yet",
      by_id[S1]["current"]["text"] == "林晚原句"
      and by_id[S1]["current"]["character"] == "林晚"
      and by_id[S1]["conflict"] is None, by_id[S1])
check("bad status filter -> 400",
      client.get("/api/suggestions?status=bogus").status_code == 400)

# 编辑者在另一个页面做一批改动：改 #2 正文（制造原文已变冲突，其他台词也被顺带改词，
# 验证「其他改动不妨碍采纳」）、删 #3、把 #4 改派给老周并移到开头
# （让老周的两句都不以林晚那句为紧前提示，可验证采纳后无关角色确认状态不变）；
# 整批只产生一个修订
resp = client.post("/api/draft", json={"revision": R0, "ops": [
    {"cid": "e1", "type": "text", "target": {"type": "line", "id": id_lz_},
     "text": "老周原句（编辑改过）"},
    {"cid": "e2", "type": "delete", "target": {"type": "line", "id": id_ah1}},
    {"cid": "e3", "type": "assign", "target": {"type": "line", "id": id_ah2},
     "character": "老周"},
    {"cid": "e4", "type": "reorder", "target": {"type": "line", "id": id_ah2},
     "anchor": None},
    {"cid": "e5", "type": "reorder", "target": {"type": "line", "id": id_lz_},
     "anchor": {"type": "line", "id": id_ah2}},
]})
check("editor batch 200", resp.status_code == 200, resp.get_json())
R1 = resp.get_json()["revision"]

# 再动一条「别的台词」（保存笔记推进修订）：验证采纳 S1 时其他台词/笔记的改动不构成阻碍
resp = client.put(f"/api/lines/{id_lz_}/note",
              json={"revision": R1, "character": "老周", "content": "老周自己的笔记"})
check("other line note ok", resp.status_code == 200, resp.get_json())
R2 = resp.get_json()["revision"]

# 清单实时反映冲突
r = client.get("/api/suggestions?status=pending").get_json()
by_id = {s["id"]: s for s in r["suggestions"]}
check("S2 conflict text_changed",
      by_id[S2]["conflict"] and by_id[S2]["conflict"]["type"] == "text_changed",
      by_id[S2])
check("S3 conflict deleted (current null)",
      by_id[S3]["conflict"] and by_id[S3]["conflict"]["type"] == "line_deleted"
      and by_id[S3]["current"] is None, by_id[S3])
check("S4 conflict reassigned",
      by_id[S4]["conflict"] and by_id[S4]["conflict"]["type"] == "line_reassigned"
      and by_id[S4]["conflict"]["currentCharacter"] == "老周", by_id[S4])
check("S1 still no conflict despite other changes",
      by_id[S1]["conflict"] is None
      and by_id[S1]["current"]["text"] == "林晚原句", by_id[S1])

# 冲突采纳：三种都拒绝（409），工作稿不变、建议保留待处理
for sid, ctype in [(S2, "text_changed"), (S3, "line_deleted"), (S4, "line_reassigned")]:
    resp = client.post(f"/api/suggestions/{sid}/decisions", json={"action": "adopt"})
    check(f"conflict adopt {ctype} -> 409", resp.status_code == 409
          and resp.get_json().get("conflictType") == ctype, (sid, resp.status_code, resp.get_json()))
check("conflict adopts keep revision",
      client.get("/api/draft").get_json()["revision"] == R2)
r = client.get("/api/suggestions").get_json()
check("conflicted suggestions stay pending",
      {s["id"]: s["status"] for s in r["suggestions"]
       if s["id"] in (S2, S3, S4)} == {S2: "pending", S3: "pending", S4: "pending"})
check("pending count still 4", r["pendingCount"] == 4)

# 成功采纳 S1：同一事务替换正文 + 推进修订 + 标记已采纳
# 先让林晚、老周在 R2 都已确认，验证采纳后受影响角色的确认状态自动变化
for who in ("林晚", "老周"):
    check(f"confirm {who} before adopt",
          client.post(f"/api/characters/{who}/confirmations", json={"revision": R2}).status_code == 201)
resp = client.post(f"/api/suggestions/{S1}/decisions", json={"action": "adopt"})
check("adopt S1 200", resp.status_code == 200, resp.get_json())
check("adopt bumps revision to R2+1", resp.get_json()["revision"] == R2 + 1,
      resp.get_json())
R3 = resp.get_json()["revision"]
r = client.get("/api/draft").get_json()
check("adopt replaced text in same tx",
      next(l for l in r["lines"] if l["id"] == id_lw)["text"] == "林晚建议句",
      r["lines"])
# 其他台词（老周，含其新笔记与改动过的正文）原样不动
lz_now = next(l for l in r["lines"] if l["id"] == id_lz_)
check("adopt leaves other lines alone", lz_now["text"] == "老周原句（编辑改过）"
      and lz_now["note"] is not None and "老周自己的笔记" in lz_now["note"]["content"])
# 建议标记已采纳
s1row = next(s for s in client.get("/api/suggestions").get_json()["suggestions"] if s["id"] == S1)
check("S1 marked adopted", s1row["status"] == "adopted" and s1row["decidedAt"]
      and s1row["decisionNote"] == f"采纳于工作稿 r{R3}", s1row)

# 确认状态按现有规则更新：林晚（正文变）待确认；
# 老周的可见内容（#2 正文/笔记、紧前提示）这次没动，保持已确认
st = {c["character"]: c["status"] for c in
      client.get("/api/confirmations").get_json()["confirmations"]}
check("adopt invalidates owner confirmation", st["林晚"] == "pending", st)
check("adopt keeps unrelated role confirmed", st["老周"] == "confirmed", st)
# 发布闸门：林晚待确认 -> 发布整次拒绝
resp = client.post("/api/publications", json={"revision": R3})
check("publish blocked after adopt (pending owner)", resp.status_code == 422
      and resp.get_json()["pendingCharacters"] == ["林晚"], resp.get_json())
# 林晚重新确认（确认不推进修订），即可发布；旧发布版 r1/r8 不受采纳影响
check("re-confirm 林晚",
      client.post("/api/characters/林晚/confirmations", json={"revision": R3}).status_code == 201)
resp = client.post("/api/publications", json={"revision": R3, "label": "采纳建议版"})
check("publish after reconfirm ok", resp.status_code == 201, resp.get_json())
r = client.get("/api/publications/1").get_json()
check("old publication r1 untouched",
      len(r["lines"]) == 7 and "一盏马灯" in r["lines"][0]["text"])

# 驳回：只改变建议状态，台词已删（S3）也能驳回；不推进修订
for sid in (S2, S3, S4):
    check(f"reject S{sid} ok",
          client.post(f"/api/suggestions/{sid}/decisions",
                      json={"action": "reject"}).status_code == 200)
# 驳回不推进修订号（S3 的台词已删除，同样不推进）
check("reject does not bump revision",
      client.get("/api/draft").get_json()["revision"] == R3)
r = client.get("/api/suggestions").get_json()
check("all suggestions decided",
      r["pendingCount"] == 0
      and {s["id"]: (s["status"], bool(s["decidedAt"])) for s in r["suggestions"]}
      and all(s["status"] in ("adopted", "rejected") for s in r["suggestions"]),
      [(s["id"], s["status"]) for s in r["suggestions"]])
# 非法 action -> 400；建议不存在 -> 404
check("bad action -> 400",
      client.post(f"/api/suggestions/{S2}/decisions", json={"action": "nope"}).status_code == 400)
check("missing suggestion -> 404",
      client.post("/api/suggestions/999999/decisions", json={"action": "adopt"}).status_code == 404)
# 已处理建议不能重复处理（采纳/驳回都一样）
check("adopted cannot re-adopt -> 422",
      client.post(f"/api/suggestions/{S1}/decisions", json={"action": "adopt"}).status_code == 422)
check("adopted cannot reject -> 422",
      client.post(f"/api/suggestions/{S1}/decisions", json={"action": "reject"}).status_code == 422)
check("rejected cannot re-adopt -> 422",
      client.post(f"/api/suggestions/{S2}/decisions", json={"action": "adopt"}).status_code == 422)
# 重复处理被拒后工作稿仍不变
check("re-decide keeps revision",
      client.get("/api/draft").get_json()["revision"] == R3)

# 建议及处理结果在容器重启（重新 init_db）后仍可查看；旧发布版保持原样
appmod.init_db()
r = client.get("/api/suggestions").get_json()
statuses = {s["id"]: s["status"] for s in r["suggestions"]}
check("suggestions survive restart",
      statuses == {S1: "adopted", S2: "rejected", S3: "rejected", S4: "rejected"},
      statuses)
s3row = next(s for s in r["suggestions"] if s["id"] == S3)
check("deleted-line suggestion history survives", s3row["current"] is None
      and s3row["originalText"] == "阿禾原句"
      and s3row["proposedText"] == "阿禾建议句一")
check("pubs untouched after restart",
      [p["revision"] for p in client.get("/api/publications").get_json()["publications"]]
      == [1, 8, R3])

# 再次删光工作稿，进入原有第 11 节场景
d = client.get("/api/draft").get_json()
while d["lines"]:
    nr = d["revision"]
    lid = d["lines"][0]["id"]
    owner = d["lines"][0]["character"]
    e0 = client.get(f"/api/characters/{owner}").get_json()["entries"][0]
    if e0["lineId"] == lid and e0["note"]:
        client.put(f"/api/lines/{lid}/note",
                  json={"revision": nr, "character": owner, "content": ""})
        nr += 1
    resp = client.post("/api/draft", json={"revision": nr, "ops": [
        {"cid": "emp2", "type": "delete", "target": {"type": "line", "id": lid}}]})
    check("drain delete ok", resp.status_code == 200, (lid, resp.status_code, resp.get_json()))
    d = client.get("/api/draft").get_json()

# 11. 没有台词：确认清单为空，全员（零角色）视为可发布；旧版仍可打开
r = client.get("/api/confirmations").get_json()
check("empty script: confirmation list empty", r["confirmations"] == [], r)
final_rev = client.get("/api/draft").get_json()["revision"]
check("empty role page 404", client.get("/api/characters/林晚").status_code == 404)
check("empty confirm unknown -> 404",
      client.post("/api/characters/林晚/confirmations",
                  json={"revision": final_rev}).status_code == 404)
resp = client.post("/api/publications", json={"revision": final_rev, "label": "空场"})
check("publish empty script allowed (no pending characters)",
      resp.status_code == 201, (resp.status_code, resp.get_json()))
check("empty publication snapshots zero lines",
      client.get(f"/api/publications/{final_rev}").get_json()["lines"] == [])
# 旧发布版仍然可打开（含建议流程中发布的 R3；旧版内容均原样保留）
check("old publications still open after empty",
      [p["revision"] for p in client.get("/api/publications").get_json()["publications"]]
      == [1, 8, R3, final_rev])

# 12. 健康检查与首页
check("healthz", client.get("/healthz").data == b"ok")
check("index served", b"app.js" in client.get("/").data)
check("spa fallback serves index",
      b"app.js" in client.get("/some/spa/route").data)

print(f"\n全部 {len(passed)} 项冒烟检查通过 ✔")
for p in passed:
    print("  -", p)
