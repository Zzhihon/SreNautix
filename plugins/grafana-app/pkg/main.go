// SreNautix Grafana 应用插件的后端入口。
package main

import (
	"os"

	"github.com/grafana/grafana-plugin-sdk-go/backend/app"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/Zzhihon/SreNautix/plugins/grafana-app/pkg/plugin"
)

func main() {
	if err := app.Manage(plugin.PluginID, plugin.NewApp, app.ManageOpts{}); err != nil {
		log.DefaultLogger.Error("plugin backend exited", "error", err.Error())
		os.Exit(1)
	}
}
