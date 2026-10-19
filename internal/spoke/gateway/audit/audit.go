// Package audit 维护 gateway 的执行审计链（DESIGN §9.4、§16.3，contract/gateway/v1/audit-record.schema.json）：
// 每条记录带 seq、prev_hash 与 sha256(JCS(去掉 hash 的记录))，先追加到本地暂存卷（每条 fsync），再以 JSONL 对象写入
// S3 兼容的审计汇（MinIO，对象锁定）。定期追加用 Ed25519 签名的检查点。审计汇不可用时 Healthy 为 false，
// gateway 不认领新的执行；进行中的执行继续追加到本地暂存，审计汇恢复后补写。
package audit

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/minio/minio-go/v7"

	"github.com/Zzhihon/SreNautix/internal/spoke/gateway/assertion"
)

// 记录类型。
const (
	TypePhase      = "phase"
	TypeWrite      = "write"
	TypeCheckpoint = "checkpoint"
)

// Approver 是批准者。
type Approver struct {
	Principal string `json:"principal"`
	Channel   string `json:"channel"`
}

// Target 是一次写入的对象。
type Target struct {
	Group       string `json:"group,omitempty"`
	Resource    string `json:"resource,omitempty"`
	Subresource string `json:"subresource,omitempty"`
	Namespace   string `json:"namespace,omitempty"`
	Name        string `json:"name,omitempty"`
	UID         string `json:"uid,omitempty"`
}

// Write 是一次 Kubernetes 或 Git 写入。
type Write struct {
	Verb    string `json:"verb"`
	Outcome string `json:"outcome"`
	Detail  string `json:"detail,omitempty"`
}

// Checkpoint 是检查点签名。
type Checkpoint struct {
	KeyID     string `json:"key_id"`
	Signature string `json:"signature"`
}

// Record 是审计链中的一条记录。
type Record struct {
	Seq           int64       `json:"seq"`
	PrevHash      string      `json:"prev_hash"`
	Chain         string      `json:"chain"`
	Cluster       string      `json:"cluster"`
	At            string      `json:"at"`
	Type          string      `json:"type"`
	ExecutionID   string      `json:"execution_id,omitempty"`
	ProposalID    string      `json:"proposal_id,omitempty"`
	Action        string      `json:"action,omitempty"`
	Phase         string      `json:"phase,omitempty"`
	Reason        string      `json:"reason,omitempty"`
	Approver      *Approver   `json:"approver,omitempty"`
	AssertionHash string      `json:"assertion_hash,omitempty"`
	AttemptID     string      `json:"attempt_id,omitempty"`
	Target        *Target     `json:"target,omitempty"`
	Write         *Write      `json:"write,omitempty"`
	Checkpoint    *Checkpoint `json:"checkpoint,omitempty"`
	Hash          string      `json:"hash"`
}

// RecordHash 返回 sha256(JCS(去掉 hash 字段的记录))。
func RecordHash(r Record) (string, error) {
	r.Hash = ""
	raw, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", err
	}
	delete(m, "hash")
	raw, err = json.Marshal(m)
	if err != nil {
		return "", err
	}
	return assertion.Hash(raw)
}

// CheckpointMessage 是检查点签名的输入：覆盖它之前的链头。
func CheckpointMessage(cluster string, headSeq int64, headHash string) []byte {
	return []byte("srenautix-audit-checkpoint-v1\n" + cluster + "\n" + strconv.FormatInt(headSeq, 10) + "\n" + headHash)
}

// SinkConfig 是 S3 兼容审计汇的设置。
type SinkConfig struct {
	Client        *minio.Client
	Bucket        string
	ObjectLock    bool
	Mode          minio.RetentionMode
	RetentionDays int
}

// Signer 是检查点签名密钥。
type Signer struct {
	KeyID string
	Key   ed25519.PrivateKey
}

// Chain 是一个集群的执行审计链。
type Chain struct {
	cluster  string
	dir      string
	sink     SinkConfig
	signer   Signer
	every    int
	now      func() time.Time
	mu       sync.Mutex
	f        *os.File
	head     Record
	uploaded int64
	pending  []Record
	sinceCP  int
	healthy  bool
	lastErr  error
}

// Options 是 Open 的参数。
type Options struct {
	Cluster string
	Dir     string
	Sink    SinkConfig
	Signer  Signer
	// CheckpointEvery 是两个检查点之间的记录数。
	CheckpointEvery int
	Now             func() time.Time
}

func (c *Chain) spoolPath() string { return filepath.Join(c.dir, "execution-"+c.cluster+".jsonl") }
func (c *Chain) watermarkPath() string {
	return filepath.Join(c.dir, "execution-"+c.cluster+".uploaded")
}
func (c *Chain) prefix() string { return "execution/" + c.cluster + "/" }

// Open 打开本地暂存并恢复链头：本地暂存为空时，从审计汇最后一个对象的最后一条记录继续（暂存卷丢失后的锚定）。
// 对象锁定要求开启时，存储桶必须启用了对象锁定，否则启动失败。
func Open(ctx context.Context, o Options) (*Chain, error) {
	if o.CheckpointEvery <= 0 || o.Cluster == "" || o.Dir == "" || o.Signer.Key == nil {
		return nil, errors.New("audit: cluster, dir, signer and checkpoint interval are required")
	}
	if o.Now == nil {
		o.Now = func() time.Time { return time.Now().UTC() }
	}
	c := &Chain{cluster: o.Cluster, dir: o.Dir, sink: o.Sink, signer: o.Signer, every: o.CheckpointEvery, now: o.Now}
	if o.Sink.ObjectLock {
		enabled, _, _, _, err := o.Sink.Client.GetObjectLockConfig(ctx, o.Sink.Bucket)
		if err != nil {
			return nil, fmt.Errorf("audit: object lock of bucket %s: %w", o.Sink.Bucket, err)
		}
		if enabled != "Enabled" {
			return nil, fmt.Errorf("audit: bucket %s does not have object lock enabled", o.Sink.Bucket)
		}
	}
	if err := os.MkdirAll(o.Dir, 0o700); err != nil {
		return nil, err
	}
	records, err := readJSONL(c.spoolPath())
	if err != nil {
		return nil, err
	}
	if err := Verify(records, nil); err != nil {
		return nil, fmt.Errorf("audit: local spool: %w", err)
	}
	if b, err := os.ReadFile(c.watermarkPath()); err == nil {
		if c.uploaded, err = strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err != nil {
			return nil, fmt.Errorf("audit: watermark: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if len(records) > 0 {
		c.head = records[len(records)-1]
		for _, r := range records {
			if r.Seq > c.uploaded {
				c.pending = append(c.pending, r)
			}
		}
	} else {
		head, err := c.sinkHead(ctx)
		if err != nil {
			return nil, err
		}
		if head != nil {
			c.head = *head
			c.uploaded = head.Seq
		} else {
			c.head = Record{Seq: 0, Hash: assertion.ZeroHash}
		}
	}
	if c.f, err = os.OpenFile(c.spoolPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err != nil {
		return nil, err
	}
	c.healthy = true
	return c, nil
}

// Close 关闭本地暂存文件。
func (c *Chain) Close() error { return c.f.Close() }

func readJSONL(path string) ([]Record, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return decodeJSONL(f)
}

func decodeJSONL(r io.Reader) ([]Record, error) {
	var out []Record
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var rec Record
		dec := json.NewDecoder(bytes.NewReader(line))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&rec); err != nil {
			return nil, fmt.Errorf("audit record %d: %w", len(out)+1, err)
		}
		out = append(out, rec)
	}
	return out, sc.Err()
}

// sinkHead 返回审计汇中最后一条记录。
func (c *Chain) sinkHead(ctx context.Context) (*Record, error) {
	var last string
	for obj := range c.sink.Client.ListObjects(ctx, c.sink.Bucket, minio.ListObjectsOptions{Prefix: c.prefix(), Recursive: true}) {
		if obj.Err != nil {
			return nil, fmt.Errorf("audit: list sink: %w", obj.Err)
		}
		if obj.Key > last {
			last = obj.Key
		}
	}
	if last == "" {
		return nil, nil
	}
	records, err := c.readObject(ctx, last)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, fmt.Errorf("audit: sink object %s is empty", last)
	}
	return &records[len(records)-1], nil
}

func (c *Chain) readObject(ctx context.Context, key string) ([]Record, error) {
	obj, err := c.sink.Client.GetObject(ctx, c.sink.Bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	return decodeJSONL(obj)
}

// ReadSink 读出审计汇中本集群的全部记录（按对象键排序），供校验与测试使用。
func (c *Chain) ReadSink(ctx context.Context) ([]Record, error) {
	var keys []string
	for obj := range c.sink.Client.ListObjects(ctx, c.sink.Bucket, minio.ListObjectsOptions{Prefix: c.prefix(), Recursive: true}) {
		if obj.Err != nil {
			return nil, obj.Err
		}
		keys = append(keys, obj.Key)
	}
	sort.Strings(keys)
	var out []Record
	for _, k := range keys {
		r, err := c.readObject(ctx, k)
		if err != nil {
			return nil, err
		}
		out = append(out, r...)
	}
	return out, nil
}

func (c *Chain) appendLocked(r Record) (Record, error) {
	r.Seq = c.head.Seq + 1
	r.PrevHash = c.head.Hash
	r.Chain = "execution"
	r.Cluster = c.cluster
	r.At = assertion.FormatTime(c.now())
	h, err := RecordHash(r)
	if err != nil {
		return Record{}, err
	}
	r.Hash = h
	line, err := json.Marshal(r)
	if err != nil {
		return Record{}, err
	}
	if _, err := c.f.Write(append(line, '\n')); err != nil {
		return Record{}, fmt.Errorf("audit: write spool: %w", err)
	}
	if err := c.f.Sync(); err != nil {
		return Record{}, fmt.Errorf("audit: sync spool: %w", err)
	}
	c.head = r
	c.pending = append(c.pending, r)
	return r, nil
}

// Append 追加一条记录到本地暂存（fsync 后返回）；每 CheckpointEvery 条追加一个签名检查点。本地暂存不可写时返回错误，
// 调用方据此停止执行。
func (c *Chain) Append(r Record) (Record, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	out, err := c.appendLocked(r)
	if err != nil {
		return Record{}, err
	}
	c.sinceCP++
	if c.sinceCP >= c.every {
		if err := c.checkpointLocked(); err != nil {
			return Record{}, err
		}
	}
	return out, nil
}

func (c *Chain) checkpointLocked() error {
	sig := ed25519.Sign(c.signer.Key, CheckpointMessage(c.cluster, c.head.Seq, c.head.Hash))
	if _, err := c.appendLocked(Record{Type: TypeCheckpoint, Checkpoint: &Checkpoint{KeyID: c.signer.KeyID,
		Signature: base64.RawURLEncoding.EncodeToString(sig)}}); err != nil {
		return err
	}
	c.sinceCP = 0
	return nil
}

// Flush 把尚未写入审计汇的记录作为一个对象写入（带对象锁定保留期）。失败时 Healthy 变为 false。
func (c *Chain) Flush(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.pending) == 0 {
		// 没有积压时探测审计汇是否可写入（存储桶可访问），让空闲时的不可用也能被发现
		ok, err := c.sink.Client.BucketExists(ctx, c.sink.Bucket)
		if err == nil && !ok {
			err = fmt.Errorf("audit: bucket %s does not exist", c.sink.Bucket)
		}
		if err != nil {
			c.healthy, c.lastErr = false, err
			return err
		}
		c.healthy, c.lastErr = true, nil
		return nil
	}
	var buf bytes.Buffer
	for _, r := range c.pending {
		line, err := json.Marshal(r)
		if err != nil {
			return err
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	first, last := c.pending[0].Seq, c.pending[len(c.pending)-1].Seq
	key := fmt.Sprintf("%s%020d-%020d.jsonl", c.prefix(), first, last)
	opts := minio.PutObjectOptions{ContentType: "application/x-ndjson"}
	if c.sink.ObjectLock {
		opts.Mode = c.sink.Mode
		opts.RetainUntilDate = c.now().Add(time.Duration(c.sink.RetentionDays) * 24 * time.Hour)
	}
	if _, err := c.sink.Client.PutObject(ctx, c.sink.Bucket, key, bytes.NewReader(buf.Bytes()), int64(buf.Len()), opts); err != nil {
		c.healthy, c.lastErr = false, err
		return fmt.Errorf("audit: put %s: %w", key, err)
	}
	if err := os.WriteFile(c.watermarkPath(), []byte(strconv.FormatInt(last, 10)), 0o600); err != nil {
		return err
	}
	c.uploaded = last
	c.pending = nil
	c.healthy, c.lastErr = true, nil
	return nil
}

// Healthy 表示最近一次写入审计汇成功。
func (c *Chain) Healthy() (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.healthy, c.lastErr
}

// Lag 返回最早一条未写入审计汇的记录距今的时长；没有积压时为 0。
func (c *Chain) Lag() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.pending) == 0 {
		return 0
	}
	t, err := assertion.ParseTime(c.pending[0].At)
	if err != nil {
		return 0
	}
	return c.now().Sub(t)
}

// Head 返回链头。
func (c *Chain) Head() Record {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.head
}

// Local 返回本地暂存中的全部记录。
func (c *Chain) Local() ([]Record, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return readJSONL(c.spoolPath())
}

// Verify 校验一段连续的记录：seq 递增、prev_hash 衔接、hash 正确；pub 不为 nil 时校验每个检查点的签名。
// 第一条记录的 prev_hash 不做衔接校验（可以从审计汇的任意对象开始）。
func Verify(records []Record, pub ed25519.PublicKey) error {
	for i, r := range records {
		h, err := RecordHash(r)
		if err != nil {
			return err
		}
		if h != r.Hash {
			return fmt.Errorf("record %d: hash %s, recomputed %s", r.Seq, r.Hash, h)
		}
		if i > 0 {
			prev := records[i-1]
			if r.Seq != prev.Seq+1 || r.PrevHash != prev.Hash {
				return fmt.Errorf("record %d does not follow record %d", r.Seq, prev.Seq)
			}
		} else if r.Seq == 1 && r.PrevHash != assertion.ZeroHash {
			return fmt.Errorf("record 1 has prev_hash %s", r.PrevHash)
		}
		if r.Type == TypeCheckpoint && pub != nil {
			sig, err := base64.RawURLEncoding.DecodeString(r.Checkpoint.Signature)
			if err != nil {
				return fmt.Errorf("checkpoint %d: %w", r.Seq, err)
			}
			if !ed25519.Verify(pub, CheckpointMessage(r.Cluster, r.Seq-1, r.PrevHash), sig) {
				return fmt.Errorf("checkpoint %d: signature does not verify", r.Seq)
			}
		}
	}
	return nil
}
