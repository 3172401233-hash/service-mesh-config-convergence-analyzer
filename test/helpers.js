/** 构造一份三资源（route -> cluster -> endpoint）都在 v3 的控制面期望配置。 */
export function intendedMesh(version = "v3") {
  return {
    resources: [
      { type: "listener", name: "http", version },
      {
        type: "route",
        name: "main",
        version,
        dependsOn: [{ type: "cluster", name: "web", version }],
        dependencyHistory: {
          v2: [{ type: "cluster", name: "web", version: "v2" }],
          v3: [{ type: "cluster", name: "web", version: "v3" }],
        },
      },
      {
        type: "cluster",
        name: "web",
        version,
        dependsOn: [{ type: "endpoint", name: "web", version }],
        dependencyHistory: {
          v2: [{ type: "endpoint", name: "web", version: "v2" }],
          v3: [{ type: "endpoint", name: "web", version: "v3" }],
        },
      },
      { type: "endpoint", name: "web", version },
    ],
  };
}

/** 构造一个代理，resources 形如 { "route/main": { acked: [...], nacked: [...], applying } }。 */
export function makeProxy(id, wave, resources) {
  return { id, wave, resources };
}

export function fullyAcked(version = "v3") {
  return {
    "listener/http": { acked: [version] },
    "route/main": { acked: [version] },
    "cluster/web": { acked: [version] },
    "endpoint/web": { acked: [version] },
  };
}
