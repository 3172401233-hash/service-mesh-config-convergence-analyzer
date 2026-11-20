import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, Status } from "../src/analyzer.js";
import { intendedMesh, makeProxy, fullyAcked } from "./helpers.js";

test("NACK 后继续使用旧版本：生效版本保持旧版并报告 NACK_STALE", () => {
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    retryPolicy: { maxRetries: 3 },
    proxies: [
      makeProxy("p1", 1, {
        ...fullyAcked("v3"),
        "route/main": {
          acked: ["v2"],
          nacked: [{ version: "v3", retries: 1 }],
        },
        // cluster/endpoint 保持 v2，避免引入额外错配干扰断言
        "cluster/web": { acked: ["v2"] },
        "endpoint/web": { acked: ["v2"] },
        "listener/http": { acked: ["v2"] },
      }),
    ],
  });
  const proxy = report.proxies[0];
  assert.equal(proxy.effectiveConfig["route/main"], "v2");
  const nack = proxy.findings.find((f) => f.code === "NACK_STALE");
  assert.ok(nack, "应报告 NACK_STALE");
  assert.equal(nack.rejectedVersion, "v3");
  assert.equal(nack.effectiveVersion, "v2");
  assert.equal(proxy.status, Status.DEGRADED);
  // 未超过重试上限，不应有 NACK_RETRIES_EXHAUSTED
  assert.ok(!proxy.findings.some((f) => f.code === "NACK_RETRIES_EXHAUSTED"));
});

test("NACK 重试耗尽升级为 critical，代理判定为 diverged", () => {
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    retryPolicy: { maxRetries: 3 },
    proxies: [
      makeProxy("p1", 1, {
        ...fullyAcked("v2"),
        "cluster/web": {
          acked: ["v2"],
          nacked: [{ version: "v3", retries: 3 }],
        },
      }),
    ],
  });
  const proxy = report.proxies[0];
  const exhausted = proxy.findings.find((f) => f.code === "NACK_RETRIES_EXHAUSTED");
  assert.ok(exhausted, "重试耗尽的 NACK 应升级");
  assert.equal(exhausted.severity, "critical");
  assert.equal(proxy.status, Status.DIVERGED);
});

test("NACK 后重试成功 ACK 新版本，状态恢复 converged", () => {
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    retryPolicy: { maxRetries: 3 },
    proxies: [
      makeProxy("p1", 1, {
        ...fullyAcked("v3"),
        "route/main": {
          acked: ["v2", "v3"],
          nacked: [{ version: "v3", retries: 2 }],
        },
      }),
    ],
  });
  const proxy = report.proxies[0];
  assert.equal(proxy.effectiveConfig["route/main"], "v3");
  assert.equal(proxy.status, Status.CONVERGED);
  assert.ok(!proxy.findings.some((f) => f.code === "NACK_STALE"));
});
