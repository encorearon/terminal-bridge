// yr-sql-guard 单元测试（node proxy/test-yr-guard.mjs，无外部依赖）
// 覆盖：只读放行 / 各类写拦截 / 注释混淆绕过尝试 / 空输入边界

import { validateReadonlySql, stripSqlComments } from "./yr-sql-guard.js";

let passed = 0;
let failed = 0;

function check(name, sql, expectOk, expectError) {
  const r = validateReadonlySql(sql);
  const okMatch = r.ok === expectOk;
  const errMatch = !expectOk ? (!expectError || r.error === expectError) : true;
  if (okMatch && errMatch) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}\n      结果: ${JSON.stringify(r)}`);
  }
}

console.log("== 只读语句应放行 ==");
check("单条 SELECT", "select * from t limit 10;", true);
check("多条 SELECT", "select 1; show tables; desc t;", true);
check("DESCRIBE/EXPLAIN", "explain select * from t", true);
check("大写动词", "SELECT DATABASE();SHOW INDEX FROM t_dk_message__8;", true);
check("行注释包裹的 select", "-- comment\nselect 1 /* x */;", true);

console.log("== 写语句应拦截 ==");
check("UPDATE", "update t set a=1", false, "write-forbidden");
check("DELETE 混在多条里", "select 1; delete from t where id=1;", false, "write-forbidden");
check("INSERT", "INSERT INTO t VALUES(1)", false, "write-forbidden");
check("DROP", "drop table t", false, "write-forbidden");
check("TRUNCATE", "truncate table t;", false, "write-forbidden");
check("USE 会话态", "use dk_shard; select 1;", false, "write-forbidden");
check("SET 变量", "set @a=1; select @a;", false, "write-forbidden");

console.log("== 隐蔽写副作用应拦截 ==");
check("INTO OUTFILE", "select * from t into outfile '/tmp/x'", false, "write-forbidden");
check("INTO DUMPFILE 大小写混淆", "select * from t Into Dumpfile '/tmp/x'", false, "write-forbidden");
check("FOR UPDATE 锁行", "select * from t where id=1 for update", false, "write-forbidden");

console.log("== 注释混淆绕过尝试应拦截 ==");
check("行注释藏写语句", "select 1; -- drop table x\ndrop table y", false, "write-forbidden");
check("块注释拆动词", "up/**/date t set a=1", false, "write-forbidden");
check("#注释后跟写语句", "# hello\ntruncate table t", false, "write-forbidden");

console.log("== 边界 ==");
check("空字符串", "", false, "empty-sql");
check("纯分号", ";;;", false, "empty-sql");
check("纯注释", "-- only comment", false, "empty-sql");

// stripSqlComments 行为直查（每种注释替换为单个空格）
const stripped = stripSqlComments("a/*b*/c -- d\ne#f");
if (stripped === "a c  \ne ") {
  passed++;
  console.log("  ok  stripSqlComments 剥离三种注释");
} else {
  failed++;
  console.error(`FAIL  stripSqlComments 实际: ${JSON.stringify(stripped)}`);
}

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
