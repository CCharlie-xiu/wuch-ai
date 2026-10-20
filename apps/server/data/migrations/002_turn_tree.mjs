// 版本 2：轮次连成树，会话有 HEAD —— 画布可以回退 / 前进，回退后再发消息长出分支。
//
//   turn.parent_id        上一轮（树的父节点）；第一轮为 NULL
//   turn.active_child_id  沿这一支往下默认走哪个孩子（切换分支 / 回退后发消息时改写）
//   turn.depth            从第一轮数起第几轮，界面上的 vN
//   turn.mode             new 重画 / edit 续画 / user 用户在画布上直接改（比如表格编辑）
//   turn.snapshot         这一轮结束时画布的完整 OpenUI Lang（续画时 raw 只是补丁）
//   turn.refs             JSON：{ 数据集 id: 版本 id }，这一轮画布引用的数据版本
//   turn.skills           JSON：这一轮选中的技能 id
//   conversation.head_turn_id  画布当前停在哪一轮；上下文 = 第一轮到 HEAD 这条路径
//   head_log              HEAD 每次移动记一笔（类似 git reflog）
//
// 回填：已有会话按 seq 串成一条链，snapshot 取 raw（没写出东西的轮次沿用上一轮），HEAD 指最后一轮。

export default function up(db, h) {
  h.addColumn('turn', 'parent_id', 'TEXT REFERENCES turn(id)');
  h.addColumn('turn', 'active_child_id', 'TEXT');
  h.addColumn('turn', 'depth', 'INTEGER NOT NULL DEFAULT 1');
  h.addColumn('turn', 'mode', "TEXT NOT NULL DEFAULT 'new'");
  h.addColumn('turn', 'snapshot', "TEXT NOT NULL DEFAULT ''");
  h.addColumn('turn', 'refs', 'TEXT');
  h.addColumn('turn', 'skills', 'TEXT');
  h.addColumn('conversation', 'head_turn_id', 'TEXT');

  h.exec(`
    CREATE INDEX IF NOT EXISTS idx_turn_parent ON turn (conversation_id, parent_id);

    CREATE TABLE IF NOT EXISTS head_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
      from_turn_id    TEXT,
      to_turn_id      TEXT,
      op              TEXT NOT NULL,          -- commit / back / forward / checkout / switch
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_head_log ON head_log (conversation_id, id);
  `);

  const convs = db.prepare('SELECT id FROM conversation').all();
  const turns = db.prepare('SELECT id, raw FROM turn WHERE conversation_id = ? ORDER BY seq');
  const setTurn = db.prepare('UPDATE turn SET parent_id = ?, active_child_id = ?, depth = ?, snapshot = ? WHERE id = ?');
  const setHead = db.prepare('UPDATE conversation SET head_turn_id = ? WHERE id = ? AND head_turn_id IS NULL');
  for (const { id } of convs) {
    const list = turns.all(id);
    let snapshot = '';
    list.forEach((t, i) => {
      if (t.raw) snapshot = t.raw;
      setTurn.run(i ? list[i - 1].id : null, list[i + 1] ? list[i + 1].id : null, i + 1, snapshot, t.id);
    });
    if (list.length) setHead.run(list[list.length - 1].id, id);
  }
}
