package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
)

// PluginID 与 src/plugin.json 的 id 一致。
const PluginID = "srenautix-console-app"

var (
	_ backend.CallResourceHandler   = (*App)(nil)
	_ instancemgmt.InstanceDisposer = (*App)(nil)
)

// Settings 是插件的 jsonData；token 在 secureJsonData.hubToken。
type Settings struct {
	HubURL     string `json:"hubUrl"`
	ConsoleURL string `json:"consoleUrl"`
}

// App 是插件实例；配置变化时 Grafana 重建实例。
type App struct {
	backend.CallResourceHandler
	proxy *Proxy
}

// ParseSettings 校验配置：中心地址必须是 http(s) 绝对地址，token 必须存在。
func ParseSettings(s backend.AppInstanceSettings) (*url.URL, string, error) {
	var cfg Settings
	if len(s.JSONData) > 0 {
		if err := json.Unmarshal(s.JSONData, &cfg); err != nil {
			return nil, "", fmt.Errorf("插件 jsonData 不是合法的 JSON：%w", err)
		}
	}
	if cfg.HubURL == "" {
		return nil, "", errors.New("插件没有配置中心地址 hubUrl")
	}
	hub, err := url.Parse(cfg.HubURL)
	if err != nil || (hub.Scheme != "http" && hub.Scheme != "https") || hub.Host == "" {
		return nil, "", fmt.Errorf("hubUrl 必须是 http 或 https 的绝对地址：%q", cfg.HubURL)
	}
	token := s.DecryptedSecureJSONData["hubToken"]
	if token == "" {
		return nil, "", errors.New("插件没有配置 Grafana 插件 token（secureJsonData.hubToken）")
	}
	return hub, token, nil
}

// NewApp 在第一次资源调用时创建实例；配置不完整时返回错误，Grafana 把错误返回给每个调用。
func NewApp(_ context.Context, s backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	hub, token, err := ParseSettings(s)
	if err != nil {
		return nil, err
	}
	return newApp(&Proxy{Hub: hub, Token: token, Client: &http.Client{Timeout: 20 * time.Second}}), nil
}

func newApp(p *Proxy) *App {
	return &App{CallResourceHandler: httpadapter.New(p), proxy: p}
}

// Dispose 在实例被替换时调用。
func (a *App) Dispose() {
	a.proxy.Client.CloseIdleConnections()
}
