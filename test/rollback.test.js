import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, Status } from "../src/analyzer.js";
import { intendedMesh, makeProxy, fullyAcked } from "./helpers.js";

test("回滚：控制面回退到 v2，部分代理仍生效 v3 时报告 ROLLBACK_PENDING", () => {
  const report = analyze({
    controlPlane: intendedMesh("v2"),
    proxies: [
      makeProxy("p1", 1, fullyAcked("v2")),
      makeProxy("p2", 2, fullyAcked("v3")),
    ],
  });
  const [p1, p2] = report.proxies;
  assert.equal(p1.status, Status.CONVERGED);
  // p2 整体停留在 v3，自身组合一致但相对控制面未回滚
  assert.equal(p2.status, Status.DEGRADED);
  assert.equal(
    p2.findings.filter((f) => f.code === "ROLLBACK_PENDING").length,
    4,
  );
  assert.equal(report.quiescent, false);
});

test("回滚途中新旧混合：部分资源已回退、部分仍是新版，判定为危险组合", () => {
  const report = analyze({
    controlPlane: intendedMesh("v2"),
    proxies: [
      makeProxy("p1", 1, {
        "listener/http": { acked: ["v3", "v2"] },
        "route/main": { acked: ["v3", "v2"] },
        "cluster/web": { acked: ["v3"] },
        "endpoint/web": { acked: ["v3"] },
      }),
    ],
  });
  const proxy = report.proxies[0];
  const mixed = proxy.findings.find((f) => f.code === "MIXED_GENERATION");
  assert.ok(mixed, "回滚途中应识别新旧混合");
  assert.deepEqual(mixed.ahead, ["cluster/web@v3", "endpoint/web@v3"]);
  assert.deepEqual(mixed.aligned, ["listener/http@v2", "route/main@v2"]);
  assert.ok(proxy.dangerousCombos.some((c) => c.kind === "mixed-generation"));
  assert.equal(proxy.status, Status.DIVERGED);
});

test("回滚完成：全部资源回到 v2 后恢复 converged", () => {
  const report = analyze({
    controlPlane: intendedMesh("v2"),
    proxies: [
      makeProxy("p1", 1, {
        "listener/http": { acked: ["v3", "v2"] },
        "route/main": { acked: ["v3", "v2"] },
        "cluster/web": { acked: ["v3", "v2"] },
        "endpoint/web": { acked: ["v3", "v2"] },
      }),
    ],
  });
  assert.equal(report.proxies[0].status, Status.CONVERGED);
  assert.equal(report.quiescent, true);
});
