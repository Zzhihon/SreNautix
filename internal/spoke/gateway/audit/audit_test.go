package audit_test

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"strings"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/audit"
	"github.com/Zzhihon/SreNautix/internal/spoke/testenv"
)

func signer() audit.Signer {
	seed := sha256.Sum256([]byte("audit-test"))
	return audit.Signer{KeyID: "audit-test", Key: ed25519.NewKeyFromSeed(seed[:])}
}

func open(t *testing.T, m *testenv.MinIO, dir string) *audit.Chain {
	t.Helper()
	c, err := audit.Open(context.Background(), audit.Options{
		Cluster: "test", Dir: dir, Signer: signer(), CheckpointEvery: 3,
		Sink: audit.SinkConfig{Client: m.Client(t), Bucket: "audit", ObjectLock: true, Mode: minio.Governance, RetentionDays: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestChainSpoolSinkAndRecovery(t *testing.T) {
	ctx := context.Background()
	m := testenv.StartMinIO(t)
	m.LockedBucket(t, "audit")
	dir := testenv.Scratch(t, "spool")
	c := open(t, m, dir)
	for i := 0; i < 4; i++ {
		if _, err := c.Append(audit.Record{Type: audit.TypePhase, ExecutionID: strings.Repeat("a", 32), Phase: "executing"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	pub := signer().Key.Public().(ed25519.PublicKey)
	sink, err := c.ReadSink(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// 4 条记录加第 3 条之后的检查点
	if len(sink) != 5 || sink[3].Type != audit.TypeCheckpoint {
		t.Fatalf("sink has %d records", len(sink))
	}
	if err := audit.Verify(sink, pub); err != nil {
		t.Fatal(err)
	}
	// 对象锁定：保留期内不能删除
	var key string
	for o := range m.Client(t).ListObjects(ctx, "audit", minio.ListObjectsOptions{Prefix: "execution/test/", Recursive: true, WithVersions: true}) {
		key = o.Key
		if err := m.Client(t).RemoveObject(ctx, "audit", o.Key, minio.RemoveObjectOptions{VersionID: o.VersionID}); err == nil {
			t.Fatalf("locked object %s was deleted", o.Key)
		}
	}
	if key == "" {
		t.Fatal("no sink object")
	}

	// 审计汇不可用：Flush 失败、Healthy 为 false，记录留在本地暂存
	m.Stop()
	if _, err := c.Append(audit.Record{Type: audit.TypePhase, Phase: "verifying"}); err != nil {
		t.Fatal(err)
	}
	fctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	if err := c.Flush(fctx); err == nil {
		t.Fatal("flush succeeded without a sink")
	}
	cancel()
	if ok, _ := c.Healthy(); ok {
		t.Fatal("chain reports healthy without a sink")
	}
	m.Start()
	if err := c.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if ok, _ := c.Healthy(); !ok {
		t.Fatal("chain did not recover")
	}

	// 暂存卷丢失：从审计汇的链头继续
	_ = c.Close()
	c2 := open(t, m, testenv.Scratch(t, "spool-new"))
	if c2.Head().Seq != 6 {
		t.Fatalf("head after restore: %d", c2.Head().Seq)
	}
	if _, err := c2.Append(audit.Record{Type: audit.TypePhase, Phase: "verified"}); err != nil {
		t.Fatal(err)
	}
	if err := c2.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	all, err := c2.ReadSink(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := audit.Verify(all, pub); err != nil || len(all) != 7 {
		t.Fatalf("chain across restore: %d records, %v", len(all), err)
	}

	// 篡改任何一条都被发现
	all[1].Phase = "verified"
	if err := audit.Verify(all, pub); err == nil {
		t.Fatal("tampered record verified")
	}
}
