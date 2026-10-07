"""Fuzz 执行器：读取 fuzzgen.js 的场景，用真实 Flask 后端逐个跑，
比对 ops 执行后的工作稿顺序/内容是否等于前端期望的 final。

运行：
  node tests/fuzzgen.js 3000 > /tmp/fuzz.json
  PYTHONPATH=... python3 tests/fuzz_run.py /tmp/fuzz.json
"""
import json
import os
import sys
import tempfile

os.environ["SCRIPT_DB"] = os.path.join(tempfile.mkdtemp(prefix="fuzz-"), "f.db")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app as appmod  # noqa: E402


def run_case(client, case):
    """在独立库初始化 initial 工作稿，提交 ops，校验结果 == final。"""
    # 重建库
    if os.path.exists(appmod.DB_PATH):
        os.remove(appmod.DB_PATH)
    for ext in ("-wal", "-shm"):
        p = appmod.DB_PATH + ext
        if os.path.exists(p):
            os.remove(p)
    appmod.init_db()

    conn = appmod.sqlite3.connect(appmod.DB_PATH, isolation_level=None)
    conn.execute("BEGIN IMMEDIATE")
    # 清空播种数据
    conn.execute("DELETE FROM pub_note")
    conn.execute("DELETE FROM pub_line")
    conn.execute("DELETE FROM publication")
    conn.execute("DELETE FROM note")
    conn.execute("DELETE FROM line")
    conn.execute("DELETE FROM sqlite_sequence WHERE name='line'")
    for i, line in enumerate(case["initial"]):
        conn.execute("INSERT INTO line (id, character, text, pos) VALUES (?, ?, ?, ?)",
                     (line["id"], line["character"], line["text"], i))
    conn.execute("UPDATE meta SET value='1' WHERE key='working_revision'")
    conn.execute("COMMIT")
    conn.close()

    resp = client.post("/api/draft", json={"revision": 1, "ops": case["ops"]})
    body = resp.get_json()
    if resp.status_code != 200:
        return False, f"HTTP {resp.status_code}: {json.dumps(body, ensure_ascii=False)[:300]}"

    got = client.get("/api/draft").get_json()
    got_lines = [(l["id"], l["character"], l["text"]) for l in got["lines"]]
    # final 中新行 id 未知，按 (character, text) 匹配；旧行按 id
    expected = [(f["id"], f["character"], f["text"]) for f in case["final"]]
    if len(got_lines) != len(expected):
        return False, f"长度不符 got={len(got_lines)} want={len(expected)}"
    for i, (g, w) in enumerate(zip(got_lines, expected)):
        if w[0] is not None and g[0] != w[0]:
            return False, f"位置{i} id不符 got={g[0]} want={w[0]}"
        if g[1] != w[1] or g[2] != w[2]:
            return False, f"位置{i} 内容不符 got={g[1:]!r} want={w[1:]!r}"
    return True, None


def main():
    cases = json.load(open(sys.argv[1]))
    client = appmod.app.test_client()
    failures = 0
    for idx, case in enumerate(cases):
        ok, err = run_case(client, case)
        if not ok:
            failures += 1
            print(f"案例 {idx} 失败: {err}")
            print("  initial:", json.dumps(case["initial"], ensure_ascii=False))
            print("  final  :", json.dumps(case["final"], ensure_ascii=False))
            print("  ops    :", json.dumps(case["ops"], ensure_ascii=False)[:800])
            if failures >= 10:
                print("失败过多，停止")
                break
    total = len(cases)
    if failures == 0:
        print(f"fuzz 全部 {total} 个随机编辑场景通过 ✔（前端 ops 算法 ⇄ 后端执行结果一致）")
    else:
        print(f"{failures}/{total} 失败")
        sys.exit(1)


if __name__ == "__main__":
    main()
