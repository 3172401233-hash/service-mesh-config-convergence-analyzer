/**
 * 服务网格配置收敛分析器（只读）。
 *
 * 输入：各代理已确认（ACK）、拒绝（NACK）、正在应用的资源版本，
 * 控制面期望的资源与依赖关系、端点变更事件、重试策略与 rollout 波次。
 * 输出：每个代理实际生效的配置组合、收敛状态、缺失资源、
 * 危险版本组合，以及建议停止的 rollout 波次。
 *
 * 本模块不连接、不修改任何 xDS 控制面，仅对快照数据做离线分析。
 */

export const RESOURCE_TYPES = ["listener", "route", "cluster", "endpoint"];

export const Status = Object.freeze({
  CONVERGED: "converged",
  CONVERGING: "converging",
  DEGRADED: "degraded",
  DIVERGED: "diverged",
});

const SEVERITY_ORDER = { info: 0, warning: 1, critical: 2 };

export function resourceKey(type, name) {
  return `${type}/${name}`;
}

/** 版本比较：优先提取尾部整数比较，否则按字典序。 */
export function compareVersions(a, b) {
  if (a === b) return 0;
  const numA = /(\d+)\D*$/.exec(String(a));
  const numB = /(\d+)\D*$/.exec(String(b));
  if (numA && numB) {
    const diff = Number(numA[1]) - Number(numB[1]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return String(a) < String(b) ? -1 : 1;
}

function indexControlPlane(resources) {
  const byKey = new Map();
  for (const res of resources ?? []) {
    byKey.set(resourceKey(res.type, res.name), res);
  }
  return byKey;
}

/** 取资源某个版本的依赖列表；无历史记录时回退到当前 dependsOn。 */
function dependenciesForVersion(resource, version) {
  if (resource.dependencyHistory && resource.dependencyHistory[version]) {
    return resource.dependencyHistory[version];
  }
  if (version === resource.version) return resource.dependsOn ?? [];
  return resource.dependsOn ?? [];
}

/** 代理某资源实际生效的版本：最后一次 ACK 的版本（NACK 后继续使用旧版本）。 */
function effectiveVersion(proxyResource) {
  if (!proxyResource || !Array.isArray(proxyResource.acked)) return null;
  const acked = proxyResource.acked.filter((v) => v != null);
  return acked.length > 0 ? acked[acked.length - 1] : null;
}

function nackedVersions(proxyResource) {
  return (proxyResource?.nacked ?? []).map((n) =>
    typeof n === "object" && n !== null ? n.version : n,
  );
}

function analyzeProxy(proxy, intended, retryPolicy, observedAtMs, applyingTimeoutMs) {
  const findings = [];
  const dangerousCombos = [];
  const missingResources = [];
  const effectiveConfig = {};
  const proxyResources = proxy.resources ?? {};
  const maxRetries = retryPolicy?.maxRetries ?? Infinity;

  for (const [key, resource] of intended) {
    const state = proxyResources[key];
    const effective = effectiveVersion(state);
    effectiveConfig[key] = effective;
    const nacks = nackedVersions(state);
    const intendedVersion = resource.version;

    if (effective === null && !state?.applying) {
      missingResources.push({
        type: resource.type,
        name: resource.name,
        expectedVersion: intendedVersion,
      });
      findings.push({
        code: "MISSING_RESOURCE",
        severity: "warning",
        resource: key,
        message: `代理缺少资源 ${key}（期望版本 ${intendedVersion}），且没有正在应用的版本`,
      });
      continue;
    }

    // NACK 后继续使用旧版本（若之后已 ACK 目标版本，则视为恢复）
    if (
      effective !== null &&
      effective !== intendedVersion &&
      nacks.includes(intendedVersion)
    ) {
      const nackEntry = (state.nacked ?? []).find(
        (n) => (typeof n === "object" && n !== null ? n.version : n) === intendedVersion,
      );
      const retries = typeof nackEntry === "object" && nackEntry !== null ? nackEntry.retries ?? 0 : 0;
      findings.push({
        code: "NACK_STALE",
        severity: "warning",
        resource: key,
        effectiveVersion: effective,
        rejectedVersion: intendedVersion,
        message: `代理拒绝了 ${key}@${intendedVersion}，继续生效旧版本 ${effective}`,
      });
      if (retries >= maxRetries) {
        findings.push({
          code: "NACK_RETRIES_EXHAUSTED",
          severity: "critical",
          resource: key,
          retries,
          message: `${key}@${intendedVersion} 重试 ${retries} 次仍被拒绝，已超过重试上限 ${maxRetries}`,
        });
      }
    } else if (effective !== null && compareVersions(effective, intendedVersion) < 0) {
      // ACK 过，但确认的不是控制面期望的版本
      findings.push({
        code: "ACK_NOT_CONVERGED",
        severity: "warning",
        resource: key,
        effectiveVersion: effective,
        expectedVersion: intendedVersion,
        message: `代理已确认 ${key}@${effective}，但控制面期望 ${intendedVersion}，配置未收敛`,
      });
    } else if (effective !== null && compareVersions(effective, intendedVersion) > 0) {
      // 代理上的版本比控制面期望的更新：典型于回滚场景
      findings.push({
        code: "ROLLBACK_PENDING",
        severity: "warning",
        resource: key,
        effectiveVersion: effective,
        expectedVersion: intendedVersion,
        message: `控制面回滚 ${key} 到 ${intendedVersion}，代理仍生效更新的 ${effective}`,
      });
    }

    // 正在应用的版本长时间未确认
    if (state?.applying && applyingTimeoutMs != null && observedAtMs != null) {
      const since = state.applying.sinceMs;
      if (since != null && observedAtMs - since > applyingTimeoutMs) {
        findings.push({
          code: "APPLYING_TIMEOUT",
          severity: "warning",
          resource: key,
          applyingVersion: state.applying.version,
          stuckMs: observedAtMs - since,
          message: `${key}@${state.applying.version} 应用已超过 ${applyingTimeoutMs}ms 未确认`,
        });
      }
    }
  }

  // 跨资源版本错配与悬空引用：基于实际生效的组合检查依赖
  for (const [key, resource] of intended) {
    const effective = effectiveConfig[key];
    if (effective === null) continue;
    for (const dep of dependenciesForVersion(resource, effective)) {
      const depKey = resourceKey(dep.type, dep.name);
      const depIntended = intended.get(depKey);
      if (!depIntended) {
        findings.push({
          code: "DANGLING_REFERENCE",
          severity: "critical",
          resource: key,
          reference: depKey,
          message: `${key}@${effective} 引用的 ${depKey} 在控制面期望配置中不存在`,
        });
        dangerousCombos.push({
          kind: "dangling-reference",
          resources: [`${key}@${effective}`],
          reference: depKey,
          description: `${key}@${effective} 引用不存在的 ${depKey}`,
        });
        continue;
      }
      const depEffective = effectiveConfig[depKey];
      if (depEffective === null) {
        findings.push({
          code: "DEPENDENCY_MISSING",
          severity: "critical",
          resource: key,
          reference: depKey,
          message: `${key}@${effective} 依赖 ${depKey}，但代理尚未生效该资源的任何版本`,
        });
        dangerousCombos.push({
          kind: "missing-dependency",
          resources: [`${key}@${effective}`],
          reference: depKey,
          description: `${key}@${effective} 生效时 ${depKey} 缺失`,
        });
        continue;
      }
      if (dep.version != null && dep.version !== depEffective) {
        findings.push({
          code: "VERSION_MISMATCH",
          severity: "critical",
          resource: key,
          reference: depKey,
          requiredVersion: dep.version,
          actualVersion: depEffective,
          message: `${key}@${effective} 需要 ${depKey}@${dep.version}，代理实际生效 ${depEffective}`,
        });
        dangerousCombos.push({
          kind: "version-mismatch",
          resources: [`${key}@${effective}`, `${depKey}@${depEffective}`],
          description: `${key}@${effective} 与 ${depKey}@${depEffective} 组合不一致（需要 ${dep.version}）`,
        });
      }
    }
  }

  // 回滚 / 分批下发导致的新旧混合：生效版本相对期望版本跨代
  // （超前、落后、已对齐三组中至少两组非空，说明代理处于混合状态）
  const ahead = [];
  const behind = [];
  const aligned = [];
  for (const [key, resource] of intended) {
    const effective = effectiveConfig[key];
    if (effective === null) continue;
    const cmp = compareVersions(effective, resource.version);
    if (cmp > 0) ahead.push(`${key}@${effective}`);
    else if (cmp < 0) behind.push(`${key}@${effective}`);
    else aligned.push(`${key}@${effective}`);
  }
  const generations = [ahead, behind, aligned].filter((g) => g.length > 0);
  if (generations.length >= 2 && (ahead.length > 0 || behind.length > 0)) {
    const parts = [];
    if (ahead.length > 0) parts.push(`超前 ${ahead.join(", ")}`);
    if (behind.length > 0) parts.push(`落后 ${behind.join(", ")}`);
    if (aligned.length > 0) parts.push(`已对齐 ${aligned.join(", ")}`);
    findings.push({
      code: "MIXED_GENERATION",
      severity: "critical",
      ahead,
      behind,
      aligned,
      message: `代理生效的配置跨越多代：${parts.join("；")}`,
    });
    dangerousCombos.push({
      kind: "mixed-generation",
      resources: [...ahead, ...behind, ...aligned],
      description: `新旧资源混合：${parts.join("；")}`,
    });
  }

  const worst = findings.reduce(
    (acc, f) => Math.max(acc, SEVERITY_ORDER[f.severity] ?? 0),
    0,
  );
  const hasNonCriticalGaps =
    missingResources.length > 0 ||
    Object.values(proxyResources).some((s) => s?.applying);

  let status;
  if (worst >= SEVERITY_ORDER.critical) status = Status.DIVERGED;
  else if (worst >= SEVERITY_ORDER.warning) status = Status.DEGRADED;
  else if (hasNonCriticalGaps) status = Status.CONVERGING;
  else status = Status.CONVERGED;

  return {
    id: proxy.id,
    wave: proxy.wave ?? null,
    status,
    effectiveConfig,
    missingResources,
    dangerousCombos,
    findings,
  };
}

function detectEndpointFlapping(endpointEvents, flap) {
  if (!flap || !Array.isArray(endpointEvents)) return [];
  const { windowMs, threshold } = flap;
  const byTarget = new Map();
  for (const event of endpointEvents) {
    const key = `${event.name}::${event.host}`;
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(event);
  }
  const flapping = [];
  for (const [key, events] of byTarget) {
    const sorted = [...events].sort((a, b) => a.atMs - b.atMs);
    let maxInWindow = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      let count = 0;
      for (let j = i; j < sorted.length; j += 1) {
        if (sorted[j].atMs - sorted[i].atMs <= windowMs) count += 1;
        else break;
      }
      maxInWindow = Math.max(maxInWindow, count);
    }
    if (maxInWindow >= threshold) {
      const [name, host] = key.split("::");
      flapping.push({ name, host, changes: maxInWindow, windowMs });
    }
  }
  return flapping;
}

/**
 * 分析入口。
 * @param {object} input 见 README 的输入 schema。
 * @returns {object} 收敛分析报告。
 */
export function analyze(input) {
  const intended = indexControlPlane(input.controlPlane?.resources);
  const retryPolicy = input.retryPolicy ?? {};
  const observedAtMs = input.rollout?.observedAtMs ?? null;
  const applyingTimeoutMs = input.applyingTimeoutMs ?? null;

  const proxies = (input.proxies ?? []).map((proxy) =>
    analyzeProxy(proxy, intended, retryPolicy, observedAtMs, applyingTimeoutMs),
  );

  const endpointFlapping = detectEndpointFlapping(input.endpointEvents, input.endpointFlap);
  for (const flap of endpointFlapping) {
    for (const proxy of proxies) {
      const epKey = [...intended.keys()].find(
        (k) => k === resourceKey("endpoint", flap.name),
      );
      if (!epKey || !(epKey in proxy.effectiveConfig)) continue;
      proxy.findings.push({
        code: "ENDPOINT_FLAPPING",
        severity: "warning",
        resource: epKey,
        host: flap.host,
        changes: flap.changes,
        message: `端点 ${flap.name} 的实例 ${flap.host} 在 ${flap.windowMs}ms 内变更 ${flap.changes} 次，代理 ${proxy.id} 的配置可能抖动`,
      });
      if (proxy.status === Status.CONVERGED || proxy.status === Status.CONVERGING) {
        proxy.status = Status.DEGRADED;
      }
    }
  }

  const quiescent = proxies.every((p) => p.status === Status.CONVERGED);
  const findings = [];
  const startedAtMs = input.rollout?.startedAtMs;
  if (
    !quiescent &&
    input.quiescentThresholdMs != null &&
    startedAtMs != null &&
    observedAtMs != null &&
    observedAtMs - startedAtMs > input.quiescentThresholdMs
  ) {
    findings.push({
      code: "CONTROL_PLANE_NOT_QUIESCENT",
      severity: "critical",
      elapsedMs: observedAtMs - startedAtMs,
      thresholdMs: input.quiescentThresholdMs,
      message: `rollout 开始 ${observedAtMs - startedAtMs}ms 后控制面仍未达到 quiescent（阈值 ${input.quiescentThresholdMs}ms）`,
    });
  }

  // 建议停止的波次：最早出现危险组合 / diverged 代理的波次及其之后全部暂停
  const riskyWaves = proxies
    .filter((p) => p.status === Status.DIVERGED || p.dangerousCombos.length > 0)
    .map((p) => p.wave)
    .filter((w) => w != null);
  const allWaves = [...new Set(proxies.map((p) => p.wave).filter((w) => w != null))].sort(
    (a, b) => a - b,
  );
  let haltWaves = [];
  let recommendation = "所有代理均无危险版本组合，rollout 可继续。";
  if (riskyWaves.length > 0) {
    const firstRisky = Math.min(...riskyWaves);
    haltWaves = allWaves.filter((w) => w >= firstRisky);
    recommendation = `波次 ${firstRisky} 出现危险版本组合，建议暂停波次 ${haltWaves.join(", ")}，待收敛后恢复。`;
  }

  return {
    quiescent,
    findings,
    proxies,
    endpointFlapping,
    rollout: {
      waves: allWaves,
      haltWaves,
      recommendation,
    },
    summary: {
      total: proxies.length,
      converged: proxies.filter((p) => p.status === Status.CONVERGED).length,
      converging: proxies.filter((p) => p.status === Status.CONVERGING).length,
      degraded: proxies.filter((p) => p.status === Status.DEGRADED).length,
      diverged: proxies.filter((p) => p.status === Status.DIVERGED).length,
    },
  };
}
