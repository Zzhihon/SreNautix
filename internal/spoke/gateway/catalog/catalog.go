// Package catalog 加载嵌入的动作目录（contract/gateway/v1/action-catalog.yaml），核对等级、档位、撤销方式与自动执行的一致性，
// 并按目录中的 JSON Schema 校验动作参数。
package catalog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	contract "github.com/Zzhihon/SreNautix/contract/gateway"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/schema"
)

// GVK 是目标的组、版本、类型与资源名。
type GVK struct {
	Group    string `json:"group"`
	Version  string `json:"version"`
	Kind     string `json:"kind"`
	Resource string `json:"resource"`
}

// Target 是动作作用的对象类型。
type Target struct {
	GVK
	Namespaced bool  `json:"namespaced"`
	Kinds      []GVK `json:"kinds"`
}

// All 返回目标可能的全部类型。
func (t Target) All() []GVK {
	if len(t.Kinds) > 0 {
		return t.Kinds
	}
	return []GVK{t.GVK}
}

// Check 是目录中声明的一项预检或校验。
type Check struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Description string `json:"description"`
}

// Write 是动作会产生的一种 Kubernetes 写入。
type Write struct {
	Group       string `json:"group"`
	Resource    string `json:"resource"`
	Subresource string `json:"subresource"`
	Verb        string `json:"verb"`
}

// Action 是目录中的一个动作。
type Action struct {
	ID                    string `json:"id"`
	Title                 string `json:"title"`
	Level                 string `json:"level"`
	FallbackLevel         string `json:"fallback_level"`
	RecreatableConditions *struct {
		ControllerManaged bool  `json:"controller_managed"`
		MinReadyReplicas  int32 `json:"min_ready_replicas"`
		PDBHeadroom       bool  `json:"pdb_headroom"`
	} `json:"recreatable_conditions"`
	MinTier         string          `json:"min_tier"`
	FallbackMinTier string          `json:"fallback_min_tier"`
	AutoExecution   string          `json:"auto_execution"`
	Target          Target          `json:"target"`
	Params          json.RawMessage `json:"params"`
	ConflictDomain  string          `json:"conflict_domain"`
	Prechecks       []Check         `json:"prechecks"`
	Verify          struct {
		WindowSeconds int     `json:"window_seconds"`
		Checks        []Check `json:"checks"`
	} `json:"verify"`
	Undo struct {
		Kind               string `json:"kind"`
		Description        string `json:"description"`
		CompensationAction string `json:"compensation_action"`
	} `json:"undo"`
	BlastRadius struct {
		Unit     string `json:"unit"`
		Method   string `json:"method"`
		LTierMax int64  `json:"l_tier_max"`
	} `json:"blast_radius"`
	Writes []Write `json:"writes"`

	params *jsonschema.Schema
}

// VerifyWindow 返回执行后校验的时间窗。
func (a *Action) VerifyWindow() time.Duration {
	return time.Duration(a.Verify.WindowSeconds) * time.Second
}

// AutoAllowed 表示目录允许该动作自动执行。
func (a *Action) AutoAllowed() bool { return a.AutoExecution == "allowed" }

// MinTierFor 返回该动作在给定等级下可接受的最低档位。
func (a *Action) MinTierFor(level string) string {
	if level == a.FallbackLevel && a.FallbackMinTier != "" {
		return a.FallbackMinTier
	}
	return a.MinTier
}

// Condition 是参数中的执行后校验条件（action-catalog.schema.json#/$defs/promqlCondition）。
type Condition struct {
	ID        string  `json:"id"`
	Query     string  `json:"query"`
	Op        string  `json:"op"`
	Threshold float64 `json:"threshold"`
	OnEmpty   string  `json:"on_empty"`
}

// Catalog 是加载并核对过的目录。
type Catalog struct {
	Actions []*Action
	byID    map[string]*Action
	cond    *jsonschema.Schema
}

// Get 返回动作。
func (c *Catalog) Get(id string) (*Action, bool) {
	a, ok := c.byID[id]
	return a, ok
}

// Load 加载嵌入的目录。
func Load() (*Catalog, error) {
	doc, err := fs.ReadFile(contract.FS, "v1/action-catalog.yaml")
	if err != nil {
		return nil, err
	}
	return Parse(doc)
}

// Parse 校验并加载目录文档。
func Parse(doc []byte) (*Catalog, error) {
	raw, err := schema.ValidateYAML(schema.ActionCatalog, doc)
	if err != nil {
		return nil, err
	}
	var f struct {
		Actions []*Action `json:"actions"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, err
	}
	c := &Catalog{Actions: f.Actions, byID: map[string]*Action{}}
	condSchema, err := schema.GetDef(schema.ActionCatalog, "promqlCondition")
	if err != nil {
		return nil, err
	}
	c.cond = condSchema
	for _, a := range f.Actions {
		if _, dup := c.byID[a.ID]; dup {
			return nil, fmt.Errorf("catalog: duplicate action %s", a.ID)
		}
		if err := lint(a); err != nil {
			return nil, err
		}
		if a.params, err = schema.CompileInline("params-"+a.ID, a.Params); err != nil {
			return nil, fmt.Errorf("catalog: params schema of %s: %w", a.ID, err)
		}
		c.byID[a.ID] = a
	}
	for _, a := range f.Actions {
		if a.Undo.CompensationAction != "" {
			if _, ok := c.byID[a.Undo.CompensationAction]; !ok {
				return nil, fmt.Errorf("catalog: %s names unknown compensation action %s", a.ID, a.Undo.CompensationAction)
			}
		}
	}
	return c, nil
}

// lint 核对等级与撤销方式、档位、自动执行之间的约束（DESIGN §9.1、§9.2，不变量 7）。
func lint(a *Action) error {
	bad := func(format string, args ...any) error {
		return fmt.Errorf("catalog: %s: %s", a.ID, fmt.Sprintf(format, args...))
	}
	wantUndo := map[string]string{
		assertion.LevelReversible:            "restore",
		assertion.LevelReversibleRecreatable: "recreate",
		assertion.LevelCompensable:           "compensate",
		assertion.LevelIrreversible:          "none",
	}[a.Level]
	if a.Undo.Kind != wantUndo {
		return bad("level %s requires undo.kind %s, got %s", a.Level, wantUndo, a.Undo.Kind)
	}
	if a.Level == assertion.LevelCompensable && (a.MinTier != assertion.TierH || a.Undo.CompensationAction == "") {
		return bad("compensable actions need min_tier H and a compensation action")
	}
	if a.AutoAllowed() && a.Level != assertion.LevelReversible && a.Level != assertion.LevelReversibleRecreatable {
		return bad("auto_execution=allowed is only possible for reversible actions, level is %s", a.Level)
	}
	recreatable := a.Level == assertion.LevelReversibleRecreatable
	if recreatable != (a.RecreatableConditions != nil) || recreatable != (a.FallbackLevel != "") || recreatable != (a.FallbackMinTier != "") {
		return bad("recreatable_conditions, fallback_level and fallback_min_tier belong to reversible_recreatable actions only")
	}
	return nil
}

// ValidateParams 校验参数：verify 按条件 schema 校验，其余字段按动作的参数 schema 校验。
func (c *Catalog) ValidateParams(a *Action, raw json.RawMessage) ([]Condition, error) {
	var m map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("params of %s: %w", a.ID, err)
	}
	var conds []Condition
	if v, ok := m["verify"]; ok {
		var list []json.RawMessage
		if err := json.Unmarshal(v, &list); err != nil {
			return nil, fmt.Errorf("params.verify of %s: %w", a.ID, err)
		}
		seen := map[string]bool{}
		for _, item := range list {
			if err := schema.ValidateValue(c.cond, item); err != nil {
				return nil, fmt.Errorf("params.verify of %s: %w", a.ID, err)
			}
			var cd Condition
			if err := json.Unmarshal(item, &cd); err != nil {
				return nil, err
			}
			if cd.OnEmpty == "" {
				cd.OnEmpty = "fail"
			}
			if seen[cd.ID] {
				return nil, fmt.Errorf("params.verify of %s: duplicate condition id %s", a.ID, cd.ID)
			}
			seen[cd.ID] = true
			conds = append(conds, cd)
		}
		delete(m, "verify")
	}
	rest, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	if err := schema.ValidateValue(a.params, rest); err != nil {
		return nil, fmt.Errorf("params of %s: %w", a.ID, err)
	}
	return conds, nil
}
