import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SkillCapability, SkillCapabilityParams, SkillState, SkillSummary } from '@srenautix/contract';
import type { PromqlEngine } from '@srenautix/integration-sdk';
import { renderMetrics, skills as sdk, type PackSet } from '@srenautix/packs-sdk';
import { logger } from '../log.js';
import type { SkillsConfig } from './config.js';

// 技能的加载与重新加载（ADR 0181 §6）：来源是镜像内置的 skills/ 与挂载的目录（每个技能一个 ConfigMap，整卷挂载），
// 后者覆盖前者的同名技能。每 skills.reload_interval 扫描一次，内容摘要变化的技能逐个校验：清单、步骤、模板、绑定 schema、
// 领域包中的绑定与引用的信号（渲染并严格解析）。全部通过才替换；任何一步失败时保留上一个可用版本并记录原因。
// 正在执行的运行使用开始时的版本。

export const BUILTIN_SKILLS_DIR = resolve(import.meta.dirname, '../../../../skills');

export interface SkillEntry {
  name: string;
  skill: sdk.LoadedSkill | null;
  bindings: sdk.ResolvedBinding[];
  loadedAt: Date | null;
  /** 最近一次加载失败的原因（旧版本继续运行）；成功后清空 */
  error: string | null;
  /** 最近一次看到的目录摘要：没有变化时不重新校验 */
  seenDigest: string | null;
}

export type RegistryEvent =
  | {
      kind: 'skill.loaded';
      data: { skill: string; version: string; digest: string; source: string; previous: string | null };
    }
  | { kind: 'skill.load_rejected'; data: { skill: string; digest: string; source: string; error: string } }
  | { kind: 'skill.unloaded'; data: { skill: string; version: string | null } };

export interface RegistryOptions {
  config: SkillsConfig;
  hostVersion: string;
  /** 当前加载的领域包（绑定与信号） */
  packs: () => PackSet;
  engine: PromqlEngine;
  /** 宿主具备的能力（数据源、GitHub App 与仓库角色、Kubernetes 只读）；没有的能力等同于没有授予 */
  hostCapabilities: ReadonlySet<SkillCapability>;
  onEvent: (e: RegistryEvent) => Promise<void>;
}

/** 技能目录里引用的领域包信号：触发、trigger.occurrences、metrics.range 与 analyze.memory_kind 的 signals */
function manifestSignals(m: sdk.LoadedSkill['manifest']): string[] {
  const out: string[] = [];
  for (const t of m.triggers) {
    if (t.kind === 'metric') {
      out.push(t.signal);
    }
  }
  for (const s of m.steps) {
    const w = (s.with ?? {}) as Record<string, unknown>;
    if (typeof w.signal === 'string') {
      out.push(w.signal);
    }
    const sig = w.signals;
    if (Array.isArray(sig)) {
      out.push(...sig.filter((x): x is string => typeof x === 'string'));
    } else if (sig && typeof sig === 'object') {
      out.push(...Object.values(sig).filter((x): x is string => typeof x === 'string'));
    }
  }
  return [...new Set(out)];
}

export class SkillRegistry {
  private readonly entries = new Map<string, SkillEntry>();

  constructor(private readonly o: RegistryOptions) {}

  private roots(): Array<{ root: string; source: (dir: string) => string }> {
    return this.o.config.sources.map((s) =>
      s.kind === 'builtin'
        ? { root: this.o.config.builtin_dir ?? BUILTIN_SKILLS_DIR, source: () => 'builtin' }
        : { root: s.path, source: (dir: string) => `dir:${dir}` },
    );
  }

  /** 扫描来源：只取 skills.enabled 中的技能，同名技能后者覆盖前者 */
  private scan(): Map<string, { dir: string; source: string }> {
    const found = new Map<string, { dir: string; source: string }>();
    for (const r of this.roots()) {
      if (!existsSync(r.root)) {
        logger.warn('技能来源目录不存在', { dir: r.root });
        continue;
      }
      for (const dir of sdk.skillDirs(r.root)) {
        const name = dir.split('/').pop()!;
        if (this.o.config.enabled.includes(name)) {
          found.set(name, { dir, source: r.source(dir) });
        }
      }
    }
    return found;
  }

  /** 一轮重新加载 */
  async reload(): Promise<void> {
    const found = this.scan();
    const set = this.o.packs();
    for (const [name, { dir, source }] of found) {
      const e = this.entries.get(name) ?? {
        name,
        skill: null,
        bindings: [],
        loadedAt: null,
        error: null,
        seenDigest: null,
      };
      this.entries.set(name, e);
      let digest: string;
      try {
        digest = sdk.skillFiles(dir).digest;
      } catch (err) {
        await this.reject(e, 'unreadable', source, err);
        continue;
      }
      if (digest === e.seenDigest) {
        continue;
      }
      e.seenDigest = digest;
      try {
        const skill = sdk.loadSkillDir(dir, source, { hostVersion: this.o.hostVersion });
        if (skill.name !== name) {
          throw new sdk.SkillLintError(dir, `目录名 ${name} 与技能名 ${skill.name} 不同`);
        }
        this.lintSignals(skill, set);
        const bindings = sdk.bindingsFor(set, skill);
        const previous = e.skill?.digest ?? null;
        e.skill = skill;
        e.bindings = bindings;
        e.loadedAt = new Date();
        e.error = null;
        logger.info('技能已加载', { skill: name, version: skill.manifest.version, digest: skill.digest, source });
        await this.o.onEvent({
          kind: 'skill.loaded',
          data: { skill: name, version: skill.manifest.version, digest: skill.digest, source, previous },
        });
      } catch (err) {
        if (!(err instanceof sdk.SkillLintError || err instanceof sdk.BindingError)) {
          throw err;
        }
        await this.reject(e, digest, source, err);
      }
    }
    for (const [name, e] of this.entries) {
      if (!found.has(name)) {
        this.entries.delete(name);
        logger.info('技能已卸载', { skill: name });
        await this.o.onEvent({
          kind: 'skill.unloaded',
          data: { skill: name, version: e.skill?.manifest.version ?? null },
        });
      }
    }
  }

  private async reject(e: SkillEntry, digest: string, source: string, err: unknown): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    e.error = msg.slice(0, 1000);
    logger.error('技能没有通过校验，保留上一个可用版本', { skill: e.name, error: msg, kept: e.skill?.digest ?? null });
    await this.o.onEvent({ kind: 'skill.load_rejected', data: { skill: e.name, digest, source, error: e.error } });
  }

  /** 清单引用的信号必须是领域包中的 metrics 信号，每个备选能渲染并严格解析 */
  private lintSignals(skill: sdk.LoadedSkill, set: PackSet): void {
    for (const key of manifestSignals(skill.manifest)) {
      const s = set.signals.get(key);
      if (!s) {
        throw new sdk.SkillLintError(`${skill.name}/skill.yaml`, `引用的信号 ${key} 不在加载的领域包中`);
      }
      if (s.signal.kind !== 'metrics') {
        throw new sdk.SkillLintError(`${skill.name}/skill.yaml`, `引用的信号 ${key} 不是 metrics 信号`);
      }
      for (const [i, alt] of s.signal.alternatives.entries()) {
        try {
          renderMetrics(this.o.engine, alt, {
            entity: { cluster_id: 'lint', kind: 'Pod', namespace: 'lint', name: 'lint', node: 'lint' },
            params: {},
            windowSeconds: 1800,
            profile: {
              namespace: 'namespace',
              pod: 'pod',
              container: 'container',
              node: 'node',
              cluster: 'cluster',
              scrape_interval_seconds: 30,
              tenant: null,
            },
          });
        } catch (err) {
          throw new sdk.SkillLintError(
            `${skill.name}/skill.yaml`,
            `信号 ${key} 的备选 ${i} 不能渲染：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  get(name: string): SkillEntry | undefined {
    return this.entries.get(name);
  }

  list(): SkillEntry[] {
    return [...this.entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /**
   * 有效能力：清单声明 ∩ values 授予 ∩ 宿主具备。参数取更严的一边：objects 取交集，max_lines 取较小者，
   * repo_role 必须相同。missing 是清单要求、没有得到的能力
   */
  effective(name: string): {
    capabilities: Partial<Record<SkillCapability, SkillCapabilityParams>>;
    missing: SkillCapability[];
  } {
    const e = this.entries.get(name);
    const declared = (e?.skill?.manifest.capabilities ?? {}) as Partial<Record<SkillCapability, SkillCapabilityParams>>;
    const granted = (this.o.config.grants[name] ?? {}) as Partial<Record<SkillCapability, SkillCapabilityParams>>;
    const capabilities: Partial<Record<SkillCapability, SkillCapabilityParams>> = {};
    const missing: SkillCapability[] = [];
    for (const [cap, want] of Object.entries(declared) as Array<[SkillCapability, SkillCapabilityParams]>) {
      const g = granted[cap];
      if (!g || !this.o.hostCapabilities.has(cap)) {
        missing.push(cap);
        continue;
      }
      if (want.repo_role && g.repo_role && want.repo_role !== g.repo_role) {
        missing.push(cap);
        continue;
      }
      const p: SkillCapabilityParams = {};
      const objects =
        want.objects && g.objects ? want.objects.filter((x) => g.objects!.includes(x)) : (want.objects ?? g.objects);
      if (objects) {
        p.objects = objects;
      }
      const lines = [want.max_lines, g.max_lines].filter((x): x is number => x !== undefined);
      if (lines.length) {
        p.max_lines = Math.min(...lines);
      }
      if (want.repo_role ?? g.repo_role) {
        p.repo_role = (want.repo_role ?? g.repo_role)!;
      }
      capabilities[cap] = p;
    }
    return { capabilities, missing: missing.sort() };
  }

  state(name: string, paused: boolean): SkillState {
    const e = this.entries.get(name);
    if (!e?.skill) {
      return 'load_failed';
    }
    if (paused) {
      return 'paused';
    }
    if (!this.o.config.enabled.includes(name)) {
      return 'not_enabled';
    }
    return this.effective(name).missing.length ? 'missing_grant' : 'active';
  }

  summary(name: string, override: { paused: boolean; reason: string | null } | undefined): SkillSummary | null {
    const e = this.entries.get(name);
    if (!e) {
      return null;
    }
    const m = e.skill?.manifest;
    const eff = this.effective(name);
    return {
      name,
      version: m?.version ?? null,
      digest: e.skill?.digest ?? null,
      source: e.skill?.source ?? null,
      title: m?.title ?? null,
      description: m?.description ?? null,
      maturity: m?.maturity ?? null,
      state: this.state(name, override?.paused === true),
      paused_reason: override?.paused ? override.reason : null,
      missing: eff.missing,
      capabilities: eff.capabilities,
      loaded_at: e.loadedAt?.toISOString() ?? null,
      load_error: e.error,
    };
  }
}
