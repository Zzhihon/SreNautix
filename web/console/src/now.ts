import { useEffect, useState } from 'react';

/** 定时刷新的当前时间；倒计时、持续时长与"多久以前"随之走动。 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
