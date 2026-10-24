import { CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';

// ops PR 的验证起点（ADR 0146 §2.6）：PR 合并之后，等管理被修改文件的 Argo CD 应用同步到包含合并提交的版本并且 Healthy。
// 应用按 spec.source(s) 的 repoURL 与 path 匹配：被修改的文件在 path 之下。版本是否包含合并提交由调用方用 GitHub 的
// compare 判断（contains）。

export interface ArgoApplication {
  name: string;
  sources: Array<{ repoURL: string; path: string | null }>;
  revisions: string[];
  synced: boolean;
  healthy: boolean;
}

export interface ArgoReader {
  applications(): Promise<ArgoApplication[]>;
}

interface RawApplication {
  metadata?: { name?: string };
  spec?: {
    source?: { repoURL?: string; path?: string };
    sources?: Array<{ repoURL?: string; path?: string }>;
  };
  status?: {
    sync?: { status?: string; revision?: string; revisions?: string[] };
    health?: { status?: string };
  };
}

export function parseApplication(a: RawApplication): ArgoApplication {
  const sources = [...(a.spec?.source ? [a.spec.source] : []), ...(a.spec?.sources ?? [])].map((s) => ({
    repoURL: s.repoURL ?? '',
    path: s.path ?? null,
  }));
  const sync = a.status?.sync;
  return {
    name: a.metadata?.name ?? '',
    sources,
    revisions: [...(sync?.revision ? [sync.revision] : []), ...(sync?.revisions ?? [])],
    synced: sync?.status === 'Synced',
    healthy: a.status?.health?.status === 'Healthy',
  };
}

/** repoURL（https、ssh、带不带 .git）是否指向 GitHub 仓库 owner/name */
export function sameRepo(repoURL: string, repo: string): boolean {
  const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(repoURL.trim());
  return m !== null && (m[1] as string).toLowerCase() === repo.toLowerCase();
}

/** 管理这些文件的应用：同一仓库，文件在 source.path 之下（path 为空或 . 时管理整个仓库） */
export function managingApplications(
  apps: readonly ArgoApplication[],
  repo: string,
  files: readonly string[],
): ArgoApplication[] {
  return apps.filter((a) =>
    a.sources.some((s) => {
      if (!sameRepo(s.repoURL, repo)) {
        return false;
      }
      const p = (s.path ?? '').replace(/^\.?\/?/, '').replace(/\/$/, '');
      return p === '' || files.some((f) => f === p || f.startsWith(`${p}/`));
    }),
  );
}

export class KubeArgoReader implements ArgoReader {
  private readonly api: CustomObjectsApi;

  constructor(
    kubeconfigPath: string | undefined,
    private readonly namespace: string,
  ) {
    const kc = new KubeConfig();
    if (kubeconfigPath) {
      kc.loadFromFile(kubeconfigPath);
    } else {
      kc.loadFromCluster();
    }
    this.api = kc.makeApiClient(CustomObjectsApi);
  }

  async applications(): Promise<ArgoApplication[]> {
    const r = (await this.api.listNamespacedCustomObject({
      group: 'argoproj.io',
      version: 'v1alpha1',
      namespace: this.namespace,
      plural: 'applications',
      limit: 500,
    })) as { items?: RawApplication[] };
    return (r.items ?? []).map(parseApplication);
  }
}
