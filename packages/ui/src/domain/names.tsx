// 组件的可读名称（ADR 0101）：事件详情里由 IncidentView 提供，子组件用 useComponentNames 取得。

import { createContext, useContext, type ReactNode } from 'react';

type Names = Readonly<Record<string, string | undefined>>;

const NamesContext = createContext<Names>({});

export function ComponentNamesProvider({ names, children }: { names: Names | undefined; children: ReactNode }) {
  return <NamesContext.Provider value={names ?? {}}>{children}</NamesContext.Provider>;
}

export function useComponentNames(): Names {
  return useContext(NamesContext);
}
