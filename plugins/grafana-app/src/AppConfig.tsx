// 插件配置页：中心地址、控制台地址与 Grafana 插件 token（存入 secureJsonData，不回显）。

import type { AppPluginMeta, PluginConfigPageProps } from '@grafana/data';
import { getBackendSrv, locationService } from '@grafana/runtime';
import { Button, Field, FieldSet, Input, SecretInput } from '@grafana/ui';
import { useState } from 'react';
import { lastValueFrom } from 'rxjs';
import type { AppSettings } from './App';
import { PLUGIN_ID } from './App';
import { PLUGIN_MESSAGES } from './messages';

function msg(id: string): string {
  const zh = (navigator.language || '').toLowerCase().startsWith('zh');
  const m = (zh ? PLUGIN_MESSAGES['zh-CN'] : PLUGIN_MESSAGES.en)[id];
  if (m === undefined) {
    throw new Error(`缺少文案 ${id}`);
  }
  return m;
}

export function AppConfig({ plugin }: PluginConfigPageProps<AppPluginMeta<AppSettings>>) {
  const { jsonData, secureJsonFields, enabled } = plugin.meta;
  const [hubUrl, setHubUrl] = useState(jsonData?.hubUrl ?? '');
  const [consoleUrl, setConsoleUrl] = useState(jsonData?.consoleUrl ?? '');
  const [token, setToken] = useState('');
  const [tokenSet, setTokenSet] = useState(Boolean(secureJsonFields?.hubToken));
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | Error>('idle');

  const save = async () => {
    setState('saving');
    const body = {
      enabled: true,
      pinned: true,
      jsonData: { hubUrl: hubUrl.trim(), consoleUrl: consoleUrl.trim() },
      ...(tokenSet ? {} : { secureJsonData: { hubToken: token } }),
    };
    try {
      await lastValueFrom(
        getBackendSrv().fetch({ url: `/api/plugins/${PLUGIN_ID}/settings`, method: 'POST', data: body }),
      );
    } catch (e) {
      setState(e instanceof Error ? e : new Error(JSON.stringify(e)));
      return;
    }
    setState('saved');
    if (!enabled) {
      locationService.reload();
    }
  };

  return (
    <FieldSet label={msg('config.title')}>
      <Field label={msg('config.hub_url')} description={msg('config.hub_url_hint')}>
        <Input id="srenautix-hub-url" value={hubUrl} onChange={(e) => setHubUrl(e.currentTarget.value)} width={60} />
      </Field>
      <Field label={msg('config.console_url')} description={msg('config.console_url_hint')}>
        <Input
          id="srenautix-console-url"
          value={consoleUrl}
          onChange={(e) => setConsoleUrl(e.currentTarget.value)}
          width={60}
        />
      </Field>
      <Field label={msg('config.token')} description={msg('config.token_hint')}>
        <SecretInput
          id="srenautix-hub-token"
          isConfigured={tokenSet}
          value={token}
          placeholder={tokenSet ? msg('config.token_set') : ''}
          onChange={(e) => setToken(e.currentTarget.value)}
          onReset={() => {
            setTokenSet(false);
            setToken('');
          }}
          width={60}
        />
      </Field>
      <Button
        onClick={() => void save()}
        disabled={state === 'saving' || !hubUrl || !consoleUrl || (!tokenSet && !token)}
      >
        {msg('config.save')}
      </Button>
      {state === 'saved' && <p role="status">{msg('config.saved')}</p>}
      {state instanceof Error && (
        <p role="alert">
          {msg('config.failed')}: {state.message}
        </p>
      )}
    </FieldSet>
  );
}
