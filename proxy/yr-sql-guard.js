// Yearning SQL 只读白名单（纯函数，供 server.js 与测试脚本共用）
//
// 红线：Yearning 通道只允许只读查询。剥离注释后按分号拆条，逐条校验首动词。
// 校验放在代理层，yr-run / yr-set / 编排模式全覆盖；不依赖页面端兜底。

// SELECT 前缀下的写副作用例外：INTO OUTFILE/DUMPFILE 写数据库服务器文件、FOR UPDATE 锁行
const HIDDEN_WRITE_RE = /\binto\s+(outfile|dumpfile)\b|\bfor\s+update\b/i;

export function stripSqlComments(sql) {
  return String(sql || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")  // 块注释
    .replace(/--[^\n]*/g, " ")          // 行注释
    .replace(/#[^\n]*/g, " ");          // MySQL # 注释
}

export function validateReadonlySql(sql) {
  const statements = stripSqlComments(sql)
    .split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0);
  if (statements.length === 0) {
    return { ok: false, error: "empty-sql", message: "SQL 为空" };
  }
  for (const stmt of statements) {
    const verb = (stmt.match(/^\S+/) || [""])[0];
    const verbUpper = verb.toUpperCase();
    if (!["SELECT", "SHOW", "DESC", "DESCRIBE", "EXPLAIN"].includes(verbUpper)) {
      return {
        ok: false,
        error: "write-forbidden",
        message: `非只读语句被拦截（${verb}）。Yearning 通道仅允许 SELECT/SHOW/DESC/EXPLAIN。`,
      };
    }
    if (HIDDEN_WRITE_RE.test(stmt)) {
      return {
        ok: false,
        error: "write-forbidden",
        message: "SELECT 中含 INTO OUTFILE/DUMPFILE 或 FOR UPDATE 等副作用子句，被拦截。",
      };
    }
  }
  return { ok: true, statementCount: statements.length };
}
