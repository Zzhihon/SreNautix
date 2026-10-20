// 局部的错误边界：全局组件（顶栏、导航、状态条、通知条）各包一层，单个组件渲染出错只影响它自己，
// 不把整个页面拖垮。出错时显示一行说明，并经上报函数报告一次。

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import styles from './ErrorBoundary.module.css';

/** 组件渲染出错时的报告 */
export interface RenderError {
  /** 出错的区域，例如 ConditionStrip */
  area: string;
  error: unknown;
  componentStack: string | null;
}

let reporter: (e: RenderError) => void = () => undefined;

/** 宿主登记组件出错时的上报函数；默认只打 console.error。 */
export function setRenderErrorReporter(fn: (e: RenderError) => void): void {
  reporter = fn;
}

function Fallback({ area, error }: { area: string; error: unknown }) {
  const { t, has } = useI18n();
  const label = has('error_boundary.failed') ? t('error_boundary.failed', { area }) : `${area} failed to render`;
  return (
    <div className={styles.fallback} role="alert" data-error-boundary={area}>
      <span>{label}</span>
      <span className={styles.detail}>{error instanceof Error ? error.message : String(error)}</span>
    </div>
  );
}

interface Props {
  area: string;
  /** 这些值变化时重新尝试渲染（例如新的数据到达） */
  resetKeys?: readonly unknown[];
  /** 自定义的降级内容；不填时显示一行说明 */
  fallback?: ReactNode;
  children: ReactNode;
}

interface State {
  error: unknown;
  keys: readonly unknown[] | undefined;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, keys: this.props.resetKeys };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error('unknown error') };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    const a = props.resetKeys ?? [];
    const b = state.keys ?? [];
    if (state.error && (a.length !== b.length || a.some((v, i) => !Object.is(v, b[i])))) {
      return { error: null, keys: props.resetKeys };
    }
    return state.keys === props.resetKeys ? null : { keys: props.resetKeys };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`组件 ${this.props.area} 渲染出错`, error);
    try {
      reporter({ area: this.props.area, error, componentStack: info.componentStack ?? null });
    } catch {
      // 上报失败不影响降级显示
    }
  }

  override render(): ReactNode {
    if (this.state.error) {
      return this.props.fallback ?? <Fallback area={this.props.area} error={this.state.error} />;
    }
    return this.props.children;
  }
}
