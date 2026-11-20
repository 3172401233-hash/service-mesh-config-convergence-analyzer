import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, Status } from "../src/analyzer.js";
import { intendedMesh, makeProxy, fullyAcked } from "./helpers.js";

test("跨资源版本错配：新路由配旧集群，识别 VERSION_MISMATCH 危险组合", () => {
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    proxies: [
      makeProxy("p1", 1, {
        ...fullyAcked("v3"),
        "cluster/web": { acked: ["v2"] },
        "endpoint/web": { acked: ["v2"] },
      }),
    ],
  });
  const proxy = report.proxies[0];
  const mismatch = proxy.findings.find(
    (f) => f.code === "VERSION_MISMATCH" && f.resource === "route/main",
  );
  assert.ok(mismatch, "route@v3 需要 cluster@v3，实际 v2");
  assert.equal(mismatch.requiredVersion, "v3");
  assert.equal(mismatch.actualVersion, "v2");
  assert.ok(
    proxy.dangerousCombos.some(
      (c) => c.kind === "version-mismatch" && c.resources.includes("route/main@v3"),
    ),
  );
  assert.equal(proxy.status, Status.DIVERGED);
});

test("路由引用控制面不存在的集群：报告 DANGLING_REFERENCE", () => {
  const mesh = intendedMesh("v3");
  mesh.resources.push({
    type: "route",
    name: "legacy",
    version: "v1",
    dependsOn: [{ type: "cluster", name: "retired", version: "v1" }],
  });
  const report = analyze({
    controlPlane: mesh,
    proxies: [
      makeProxy("p1", 1, {
        ...fullyAcked("v3"),
        "route/legacy": { acked: ["v1"] },
      }),
    ],
  });
  const proxy = report.proxies[0];
  const dangling = proxy.findings.find((f) => f.code === "DANGLING_REFERENCE");
  assert.ok(dangling, "应识别悬空引用");
  assert.equal(dangling.reference, "cluster/retired");
  assert.ok(proxy.dangerousCombos.some((c) => c.kind === "dangling-reference"));
  assert.equal(proxy.status, Status.DIVERGED);
});

test("依赖历史：代理停留在 route@v2 时按 v2 的依赖校验，不误报错配", () => {
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    proxies: [
      makeProxy("p1", 1, {
        ...fullyAcked("v2"),
        "route/main": { acked: ["v2"], applying: { version: "v3", sinceMs: 100 } },
      }),
    ],
  });
  const proxy = report.proxies[0];
  // route@v2 依赖 cluster@v2，代理生效 cluster@v2，无 VERSION_MISMATCH
  assert.ok(
    !proxy.findings.some(
      (f) => f.code === "VERSION_MISMATCH" && f.resource === "route/main",
    ),
  );
});

test("控制面长时间未 quiescent 且建议停止危险波次", () => {
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    proxies: [
      makeProxy("p1", 1, fullyAcked("v3")),
      makeProxy("p2", 2, {
        ...fullyAcked("v3"),
        "route/main": { acked: ["v3"] },
        "cluster/web": { acked: ["v2"] },
        "endpoint/web": { acked: ["v2"] },
      }),
      makeProxy("p3", 3, fullyAcked("v2")),
    ],
    rollout: { startedAtMs: 0, observedAtMs: 120_000 },
    quiescentThresholdMs: 60_000,
  });
  assert.equal(report.quiescent, false);
  assert.ok(report.findings.some((f) => f.code === "CONTROL_PLANE_NOT_QUIESCENT"));
  // p2 在波次 2 出现危险组合，建议暂停波次 2 及之后
  assert.deepEqual(report.rollout.haltWaves, [2, 3]);
  assert.match(report.rollout.recommendation, /波次 2/);
});

test("全部收敛时 quiescent 且不产生全局告警", () => {
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    proxies: [makeProxy("p1", 1, fullyAcked("v3")), makeProxy("p2", 2, fullyAcked("v3"))],
    rollout: { startedAtMs: 0, observedAtMs: 120_000 },
    quiescentThresholdMs: 60_000,
  });
  assert.equal(report.quiescent, true);
  assert.equal(report.findings.length, 0);
  assert.deepEqual(report.rollout.haltWaves, []);
});
