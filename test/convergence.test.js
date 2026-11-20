import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, Status } from "../src/analyzer.js";
import { intendedMesh, makeProxy, fullyAcked } from "./helpers.js";

test("逐步收敛：按依赖安全顺序逐个 ACK，最终达到 converged", () => {
  const steps = [
    { "endpoint/web": { acked: ["v3"] } },
    { "endpoint/web": { acked: ["v3"] }, "cluster/web": { acked: ["v3"] } },
    {
      "endpoint/web": { acked: ["v3"] },
      "cluster/web": { acked: ["v3"] },
      "route/main": { acked: ["v3"] },
    },
    fullyAcked("v3"),
  ];

  const statuses = steps.map(
    (resources) =>
      analyze({
        controlPlane: intendedMesh("v3"),
        proxies: [makeProxy("p1", 1, resources)],
      }).proxies[0].status,
  );

  // 中间步骤缺少资源但无危险组合
  assert.deepEqual(statuses.slice(0, 3), [
    Status.DEGRADED,
    Status.DEGRADED,
    Status.DEGRADED,
  ]);
  assert.equal(statuses[3], Status.CONVERGED);

  const finalReport = analyze({
    controlPlane: intendedMesh("v3"),
    proxies: [makeProxy("p1", 1, fullyAcked("v3"))],
  });
  assert.equal(finalReport.quiescent, true);
  assert.equal(finalReport.summary.converged, 1);
});

test("乱序下发时 route 先生效而 cluster 缺失，判定为 diverged 并给出危险组合", () => {
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    proxies: [
      makeProxy("p1", 1, {
        "listener/http": { acked: ["v3"] },
        "route/main": { acked: ["v3"] },
      }),
    ],
  });
  const proxy = report.proxies[0];
  assert.equal(proxy.status, Status.DIVERGED);
  assert.ok(proxy.findings.some((f) => f.code === "DEPENDENCY_MISSING"));
  assert.ok(proxy.dangerousCombos.some((c) => c.kind === "missing-dependency"));
});

test("正在应用中的资源视为 converging，缺失资源会列入 missingResources", () => {
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    proxies: [
      makeProxy("p1", 1, {
        ...fullyAcked("v3"),
        "listener/http": { acked: [], applying: { version: "v3", sinceMs: 1000 } },
      }),
    ],
  });
  // endpoint 曾 ACK v3 又重新 applying v3 的场景：无任何 ACK 时按 applying 处理
  const proxy = report.proxies[0];
  assert.equal(proxy.status, Status.CONVERGING);
  assert.equal(proxy.missingResources.length, 0);

  const missing = analyze({
    controlPlane: intendedMesh("v3"),
    proxies: [makeProxy("p2", 1, { "listener/http": { acked: ["v3"] } })],
  }).proxies[0];
  assert.deepEqual(
    missing.missingResources.map((r) => `${r.type}/${r.name}`).sort(),
    ["cluster/web", "endpoint/web", "route/main"],
  );
});

test("ACK 旧版本且正在应用新版本时，同时报告 ACK_NOT_CONVERGED 与跨资源错配", () => {
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    proxies: [
      makeProxy("p1", 1, {
        ...fullyAcked("v3"),
        "endpoint/web": { acked: ["v2"], applying: { version: "v3", sinceMs: 1000 } },
      }),
    ],
  });
  const proxy = report.proxies[0];
  assert.equal(proxy.effectiveConfig["endpoint/web"], "v2");
  assert.ok(
    proxy.findings.some((f) => f.code === "ACK_NOT_CONVERGED" && f.resource === "endpoint/web"),
  );
  // cluster/web@v3 依赖 endpoint/web@v3，实际生效 v2
  assert.ok(
    proxy.findings.some(
      (f) => f.code === "VERSION_MISMATCH" && f.resource === "cluster/web",
    ),
  );
  assert.equal(proxy.status, Status.DIVERGED);
});

test("全局版本号一致不代表收敛：ACK 的版本低于控制面期望时报告 ACK_NOT_CONVERGED", () => {
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    proxies: [makeProxy("p1", 1, fullyAcked("v2"))],
  });
  const proxy = report.proxies[0];
  assert.equal(proxy.status, Status.DEGRADED);
  assert.equal(
    proxy.findings.filter((f) => f.code === "ACK_NOT_CONVERGED").length,
    4,
  );
  assert.equal(report.quiescent, false);
});
