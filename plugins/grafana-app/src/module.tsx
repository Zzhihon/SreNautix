import { AppPlugin } from '@grafana/data';
import App, { type AppSettings } from './App';
import { AppConfig } from './AppConfig';

export const plugin = new AppPlugin<AppSettings>().setRootPage(App).addConfigPage({
  title: 'Configuration',
  icon: 'cog',
  body: AppConfig,
  id: 'configuration',
});
