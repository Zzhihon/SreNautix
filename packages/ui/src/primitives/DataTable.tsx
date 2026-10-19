// 表格：TanStack Table + 虚拟滚动。行数超过 virtualizeAbove 时只渲染可见行。空表格必须给出
// 写明原因的空状态。

import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import styles from './DataTable.module.css';

export type { ColumnDef } from '@tanstack/react-table';

const ROW_HEIGHT = 38;

export function DataTable<T>({
  data,
  columns,
  getRowId,
  label,
  empty,
  onRowClick,
  virtualizeAbove = 100,
  maxHeight = 640,
  initialSort = [],
  rowTone,
}: {
  data: readonly T[];
  // TanStack 的列定义对每列的值类型是协变的，这里只能用 any 接收不同值类型的列
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ReadonlyArray<ColumnDef<T, any>>;
  getRowId: (row: T) => string;
  label: string;
  /** 没有行时显示的空状态（必须写明原因）。 */
  empty: ReactNode;
  onRowClick?: (row: T) => void;
  virtualizeAbove?: number;
  maxHeight?: number;
  initialSort?: SortingState;
  rowTone?: (row: T) => 'bad' | 'warn' | undefined;
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSort);
  const table = useReactTable({
    data: data as T[],
    columns: columns as ColumnDef<T, unknown>[],
    getRowId: (r) => getRowId(r),
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const rows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length > virtualizeAbove;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    enabled: virtual,
  });

  if (!data.length) {
    return <>{empty}</>;
  }

  const items = virtual ? virtualizer.getVirtualItems() : null;
  const visible = items ? items.map((v) => rows[v.index]!) : rows;
  const padTop = items && items.length ? items[0]!.start : 0;
  const padBottom = items && items.length ? virtualizer.getTotalSize() - items[items.length - 1]!.end : 0;
  const colCount = table.getVisibleLeafColumns().length;

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      style={virtual ? { maxHeight, overflowY: 'auto' } : undefined}
      role={virtual ? 'region' : undefined}
      aria-label={virtual ? label : undefined}
      tabIndex={virtual ? 0 : undefined}
    >
      <table className={styles.table} aria-label={label}>
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => {
                const sort = h.column.getIsSorted();
                const canSort = h.column.getCanSort() && h.column.columnDef.enableSorting === true;
                return (
                  <th
                    key={h.id}
                    scope="col"
                    aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined}
                  >
                    {h.isPlaceholder ? null : canSort ? (
                      <button type="button" className={styles.sort} onClick={h.column.getToggleSortingHandler()}>
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {sort === 'asc' && <ArrowUp aria-hidden="true" />}
                        {sort === 'desc' && <ArrowDown aria-hidden="true" />}
                      </button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {padTop > 0 && (
            <tr aria-hidden="true">
              <td colSpan={colCount} style={{ height: padTop, padding: 0, border: 0 }} />
            </tr>
          )}
          {visible.map((row) => (
            <tr
              key={row.id}
              data-tone={rowTone?.(row.original)}
              className={onRowClick ? styles.clickable : undefined}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
          {padBottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={colCount} style={{ height: padBottom, padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
