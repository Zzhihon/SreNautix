package kube

import (
	"context"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"

	"github.com/Zzhihon/SreNautix/internal/spoke/reader/topology"
)

// CRDSource 是自定义资源识别器及其所需的客户端。
type CRDSource struct {
	Discovery   discovery.DiscoveryInterface
	Dynamic     dynamic.Interface
	Recognizers []topology.Recognizer
	// Every 是重新发现资源的间隔
	Every time.Duration
}

type crdInformer struct {
	cancel   context.CancelFunc
	informer cache.SharedIndexInformer
	kind     string
}

type crdWatcher struct {
	src *CRDSource
	w   *Watcher

	mu      sync.Mutex
	running map[schema.GroupVersionResource]*crdInformer
}

func newCRDWatcher(src *CRDSource, w *Watcher) *crdWatcher {
	return &crdWatcher{src: src, w: w, running: map[schema.GroupVersionResource]*crdInformer{}}
}

func (c *crdWatcher) run(ctx context.Context) {
	t := time.NewTicker(c.src.Every)
	defer t.Stop()
	for {
		c.sync(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// served 判断 apiserver 当前是否提供 gvr。
func (c *crdWatcher) served(gvr schema.GroupVersionResource) (bool, error) {
	list, err := c.src.Discovery.ServerResourcesForGroupVersion(gvr.GroupVersion().String())
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, r := range list.APIResources {
		if r.Name == gvr.Resource {
			return true, nil
		}
	}
	return false, nil
}

// sync 为新出现的资源启动 informer，为消失的资源停止 informer 并撤回它的全部贡献。发现失败时保持现状，
// 错误记为该资源的 watch 错误，体现在新鲜度条件里。
func (c *crdWatcher) sync(ctx context.Context) {
	for _, r := range c.src.Recognizers {
		gvr := r.Resource()
		name := gvr.Resource + "." + gvr.Group
		ok, err := c.served(gvr)
		c.mu.Lock()
		cur := c.running[gvr]
		c.mu.Unlock()
		switch {
		case err != nil:
			if cur != nil {
				c.w.fresh.watchError(name, err)
			}
		case ok && cur == nil:
			c.start(ctx, r, name)
		case !ok && cur != nil:
			c.stop(gvr, name, cur)
		}
	}
}

func (c *crdWatcher) start(ctx context.Context, r topology.Recognizer, name string) {
	gvr := r.Resource()
	kind := topology.KindName(gvr.Group, r.Kind())
	inf := dynamicinformer.NewFilteredDynamicInformer(c.src.Dynamic, gvr, metav1.NamespaceAll, 0, cache.Indexers{}, nil).Informer()
	t := typed{name: name, kind: kind, informer: inf, extract: func(o any) (topology.Contribution, bool) {
		return r.Extract(o.(*unstructured.Unstructured)), true
	}}
	if err := c.w.register(t); err != nil {
		panic(err)
	}
	cctx, cancel := context.WithCancel(ctx)
	c.mu.Lock()
	c.running[gvr] = &crdInformer{cancel: cancel, informer: inf, kind: kind}
	c.mu.Unlock()
	go inf.Run(cctx.Done())
	go func() {
		if cache.WaitForCacheSync(cctx.Done(), inf.HasSynced) {
			c.w.fresh.markSynced(name)
		}
	}()
}

func (c *crdWatcher) stop(gvr schema.GroupVersionResource, name string, cur *crdInformer) {
	cur.cancel()
	now := c.w.clock.Now()
	for _, o := range cur.informer.GetStore().List() {
		u := o.(*unstructured.Unstructured)
		c.w.applyMu.Lock()
		c.w.emit(c.w.store.Remove(contributorID(cur.kind, u), now))
		c.w.applyMu.Unlock()
	}
	c.w.fresh.untrack(name)
	c.mu.Lock()
	delete(c.running, gvr)
	c.mu.Unlock()
}

// RunningCRDs 返回当前已启动 informer 的自定义资源。
func (w *Watcher) RunningCRDs() []schema.GroupVersionResource {
	if w.crds == nil {
		return nil
	}
	w.crds.mu.Lock()
	defer w.crds.mu.Unlock()
	out := make([]schema.GroupVersionResource, 0, len(w.crds.running))
	for g := range w.crds.running {
		out = append(out, g)
	}
	return out
}
