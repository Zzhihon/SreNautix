package execution

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/client-go/dynamic"
)

// Store 读写一个命名空间中的 ActionExecution。所有 status 写入都带 resourceVersion 前置条件。
type Store struct {
	ri dynamic.ResourceInterface
}

// NewStore 返回命名空间 ns 的 Store。
func NewStore(dyn dynamic.Interface, ns string) *Store {
	return &Store{ri: dyn.Resource(GVR).Namespace(ns)}
}

func toUnstructured(x *ActionExecution) (*unstructured.Unstructured, error) {
	raw, err := json.Marshal(x)
	if err != nil {
		return nil, err
	}
	u := &unstructured.Unstructured{}
	if err := u.UnmarshalJSON(raw); err != nil {
		return nil, err
	}
	return u, nil
}

func fromUnstructured(u *unstructured.Unstructured) (*ActionExecution, error) {
	raw, err := u.MarshalJSON()
	if err != nil {
		return nil, err
	}
	x := &ActionExecution{}
	if err := json.Unmarshal(raw, x); err != nil {
		return nil, fmt.Errorf("actionexecution %s: %w", u.GetName(), err)
	}
	return x, nil
}

// Create 创建对象（status 由随后的 UpdateStatus 写入）；已存在时返回 apierrors.IsAlreadyExists 的错误。
func (s *Store) Create(ctx context.Context, x *ActionExecution) (*ActionExecution, error) {
	x.APIVersion, x.Kind = GVR.GroupVersion().String(), "ActionExecution"
	u, err := toUnstructured(x)
	if err != nil {
		return nil, err
	}
	out, err := s.ri.Create(ctx, u, metav1.CreateOptions{})
	if err != nil {
		return nil, err
	}
	return fromUnstructured(out)
}

// DryRunCreate 以 dryRun=All 提交创建（准入自检）。
func (s *Store) DryRunCreate(ctx context.Context, x *ActionExecution) error {
	x.APIVersion, x.Kind = GVR.GroupVersion().String(), "ActionExecution"
	u, err := toUnstructured(x)
	if err != nil {
		return err
	}
	_, err = s.ri.Create(ctx, u, metav1.CreateOptions{DryRun: []string{metav1.DryRunAll}})
	return err
}

// Get 读取对象。
func (s *Store) Get(ctx context.Context, name string) (*ActionExecution, error) {
	u, err := s.ri.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	return fromUnstructured(u)
}

// List 返回全部对象，按 spec.pulledAt 与名称排序。
func (s *Store) List(ctx context.Context) ([]*ActionExecution, error) {
	l, err := s.ri.List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	var out []*ActionExecution
	for i := range l.Items {
		x, err := fromUnstructured(&l.Items[i])
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Spec.PulledAt.Equal(&out[j].Spec.PulledAt) {
			return out[i].Spec.PulledAt.Before(&out[j].Spec.PulledAt)
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// UpdateStatus 写入 status；对象的 resourceVersion 已变化时返回冲突错误。
func (s *Store) UpdateStatus(ctx context.Context, x *ActionExecution) (*ActionExecution, error) {
	u, err := toUnstructured(x)
	if err != nil {
		return nil, err
	}
	out, err := s.ri.UpdateStatus(ctx, u, metav1.UpdateOptions{})
	if err != nil {
		return nil, err
	}
	return fromUnstructured(out)
}
