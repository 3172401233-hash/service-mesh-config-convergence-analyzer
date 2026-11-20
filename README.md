# service-mesh-config-convergence-analyzer

分析服务网格配置分批下发中的收敛和版本偏差。

控制面分批下发 listener、route、cluster、endpoint 配置时，各代理可能短暂组合出
新旧版本不一致的状态；仅比较全局版本号无法发现"某个代理收到了新路由却仍在使用
旧端点"这类问题。本工具根据各代理已确认（ACK）、拒绝（NACK）和正在应用的资源
版本，结合资源依赖关系、端点变更、重试策略和 rollout 波次，计算每个代理**实际
生效的配置组合**并识别风险。

> **重要：本分析器是只读的离线分析工具。它不连接、不操作、不修改任何 xDS 控制面，
> 不下发任何配置。** 输入是控制面与代理状态的快照 JSON，输出是分析报告。

## 环境

- Node.js >= 24.16.0（使用 `node:test` 与 ES Modules，无第三方依赖）

## 使用

```bash
node bin/analyze.js examples/snapshot.json
```

输出 JSON 报告；存在未收敛或 diverged 代理时进程以退出码 1 结束，便于 CI 门禁。

也可作为库使用：

```js
import { analyze } from "./src/analyzer.js";
const report = analyze(snapshot);
```

## 输入快照

```jsonc
{
  "controlPlane": {
    "resources": [
      {
        "type": "route",            // listener | route | cluster | endpoint
        "name": "main",
        "version": "v3",            // 控制面当前期望版本
        "dependsOn": [{ "type": "cluster", "name": "web", "version": "v3" }],
        "dependencyHistory": {      // 可选：各历史版本的依赖，用于校验混合状态
          "v2": [{ "type": "cluster", "name": "web", "version": "v2" }]
        }
      }
    ]
  },
  "proxies": [
    {
      "id": "edge-1",
      "wave": 1,
      "resources": {
        "route/main": {
          "acked": ["v2", "v3"],                        // 按时间顺序的 ACK
          "nacked": [{ "version": "v3", "retries": 1 }], // NACK 及已重试次数
          "applying": { "version": "v4", "sinceMs": 1000 }
        }
      }
    }
  ],
  "retryPolicy": { "maxRetries": 3 },
  "endpointEvents": [{ "name": "web", "host": "10.0.0.7:8080", "change": "remove", "atMs": 90000 }],
  "endpointFlap": { "windowMs": 5000, "threshold": 4 },
  "rollout": { "startedAtMs": 0, "observedAtMs": 120000 },
  "quiescentThresholdMs": 60000,
  "applyingTimeoutMs": 30000
}
```

代理某资源**实际生效的版本 = 最后一次 ACK 的版本**；NACK 表示代理拒绝新版本并
继续沿用旧版本。

## 识别的问题

| 代码 | 严重级 | 含义 |
| --- | --- | --- |
| `ACK_NOT_CONVERGED` | warning | 已 ACK 但版本低于控制面期望，配置未收敛 |
| `NACK_STALE` | warning | NACK 后继续使用旧版本 |
| `NACK_RETRIES_EXHAUSTED` | critical | NACK 重试次数达到 `retryPolicy.maxRetries` |
| `MISSING_RESOURCE` | warning | 代理缺少期望资源且没有正在应用的版本 |
| `DEPENDENCY_MISSING` | critical | 生效资源依赖的另一资源在代理上完全缺失 |
| `VERSION_MISMATCH` | critical | 跨资源版本错配（如新路由配旧集群） |
| `DANGLING_REFERENCE` | critical | 路由引用控制面期望配置中不存在的集群 |
| `MIXED_GENERATION` | critical | 回滚/分批下发途中新旧资源混合（超前/落后/已对齐跨代） |
| `ROLLBACK_PENDING` | warning | 控制面已回滚，代理仍生效更新版本 |
| `APPLYING_TIMEOUT` | warning | 版本应用超过 `applyingTimeoutMs` 未确认 |
| `ENDPOINT_FLAPPING` | warning | 端点实例在窗口内反复上下线 |
| `CONTROL_PLANE_NOT_QUIESCENT` | critical | 超过 `quiescentThresholdMs` 控制面仍未 quiescent |

## 输出

每个代理包含：

- `status`：`converged` / `converging` / `degraded` / `diverged`
- `effectiveConfig`：实际生效的资源版本组合
- `missingResources`：仍缺失的资源及期望版本
- `dangerousCombos`：危险版本组合（版本错配、悬空引用、新旧混合）
- `findings`：全部问题明细

报告级字段：

- `quiescent`：是否全部代理收敛
- `rollout.haltWaves` / `rollout.recommendation`：建议停止的 rollout 波次
  （最早出现危险组合的波次及其之后全部暂停）
- `endpointFlapping`：抖动端点列表
- `summary`：各状态代理计数

## 测试

```bash
node --test
```

覆盖：逐步收敛、NACK（含重试耗尽与恢复）、端点抖动、回滚（含新旧混合）、
跨资源依赖（版本错配、悬空引用、依赖历史）以及 quiescent 与波次停止建议。
