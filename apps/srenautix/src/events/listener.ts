import { EventEmitter } from 'node:events';
import pg from 'pg';
import { logger } from '../log.js';
import type { PgConfig } from '../store/pool.js';
import { NOTIFY_CHANNEL, type Owner } from '../store/outbox.js';

/**
 * 用一条专用连接 LISTEN outbox 频道，把通知转成进程内的 `wake` 事件（参数为所有者与 seq）。
 * 连接断开时每 2 秒重连一次；重连成功后发出一次不带 seq 的唤醒，消费者据此补读断开期间的事件。
 */
export class OutboxListener extends EventEmitter {
  private client: pg.Client | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  connected = false;

  constructor(
    private readonly cfg: PgConfig,
    private readonly applicationName: string,
  ) {
    super();
    this.setMaxListeners(0);
  }

  start(): void {
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const ssl =
      this.cfg.sslMode === 'disable'
        ? false
        : this.cfg.sslMode === 'require'
          ? { rejectUnauthorized: false }
          : { rejectUnauthorized: true, ca: this.cfg.caCert ?? undefined, servername: this.cfg.host };
    const c = new pg.Client({
      host: this.cfg.host,
      port: this.cfg.port,
      database: this.cfg.database,
      user: this.cfg.user,
      password: this.cfg.password,
      ssl,
      application_name: `${this.applicationName}-listen`,
      connectionTimeoutMillis: 5_000,
    });
    c.on('notification', (n) => {
      if (n.channel !== NOTIFY_CHANNEL || !n.payload) {
        return;
      }
      const [owner, seq] = n.payload.split(':');
      this.emit('wake', owner as Owner, Number(seq));
    });
    c.on('error', (e) => this.lost(c, e));
    c.on('end', () => this.lost(c, new Error('LISTEN 连接已关闭')));
    try {
      await c.connect();
      await c.query(`LISTEN ${NOTIFY_CHANNEL}`);
    } catch (e) {
      this.lost(c, e as Error);
      return;
    }
    this.client = c;
    this.connected = true;
    this.emit('wake', null, null);
  }

  private lost(c: pg.Client, e: Error): void {
    if (this.client !== null && this.client !== c) {
      return;
    }
    const was = this.connected;
    this.client = null;
    this.connected = false;
    c.removeAllListeners('notification');
    void c.end().catch(() => undefined);
    if (was) {
      logger.warn('outbox LISTEN 连接断开，2 秒后重连', { error: e.message });
    }
    if (!this.stopped && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.connect();
      }, 2_000);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const c = this.client;
    this.client = null;
    this.connected = false;
    if (c) {
      await c.end().catch(() => undefined);
    }
  }

  /** 等待下一次唤醒或超时；返回是否被唤醒。 */
  waitWake(owner: Owner, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(t);
        this.off('wake', onWake);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onWake = (o: Owner | null) => {
        if (o === null || o === owner) {
          done(true);
        }
      };
      const onAbort = () => done(false);
      const t = setTimeout(() => done(false), timeoutMs);
      this.on('wake', onWake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
