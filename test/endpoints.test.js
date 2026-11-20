import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, Status } from "../src/analyzer.js";
import { intendedMesh, makeProxy, fullyAcked } from "./helpers.js";

test("端点抖动：窗口内反复上下线的实例被标记为 flapping", () => {
  const events = [];
  for (let i = 0; i < 5; i += 1) {
    events.push({
      name: "web",
      host: "10.0.0.7:8080",
      change: i % 2 === 0 ? "remove" : "add",
      atMs: 1000 + i * 500,
    });
  }
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    proxies: [makeProxy("p1", 1, fullyAcked("v3"))],
    endpointEvents: events,
    endpointFlap: { windowMs: 5000, threshold: 4 },
  });
  assert.equal(report.endpointFlapping.length, 1);
  assert.equal(report.endpointFlapping[0].host, "10.0.0.7:8080");
  const proxy = report.proxies[0];
  assert.ok(proxy.findings.some((f) => f.code === "ENDPOINT_FLAPPING"));
  assert.equal(proxy.status, Status.DEGRADED);
});

test("稳定的端点变更不触发 flapping", () => {
  const report = analyze({
    controlPlane: intendedMesh("v3"),
    proxies: [makeProxy("p1", 1, fullyAcked("v3"))],
    endpointEvents: [
      { name: "web", host: "10.0.0.7:8080", change: "add", atMs: 1000 },
      { name: "web", host: "10.0.0.8:8080", change: "add", atMs: 2000 },
    ],
    endpointFlap: { windowMs: 5000, threshold: 4 },
  });
  assert.equal(report.endpointFlapping.length, 0);
  assert.equal(report.proxies[0].status, Status.CONVERGED);
});
