#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { analyze } from "../src/analyzer.js";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("用法: mesh-convergence-analyze <snapshot.json>");
    console.error("离线分析服务网格配置收敛状态；不连接、不修改任何 xDS 控制面。");
    process.exitCode = 2;
    return;
  }
  let input;
  try {
    input = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    console.error(`无法读取输入 ${file}: ${err.message}`);
    process.exitCode = 2;
    return;
  }
  const report = analyze(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  // 存在 diverged 代理或控制面不 quiescent 时以非零退出，便于 CI 门禁
  if (!report.quiescent || report.summary.diverged > 0) {
    process.exitCode = 1;
  }
}

main();
