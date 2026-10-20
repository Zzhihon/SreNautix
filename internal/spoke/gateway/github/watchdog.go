package github

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

// 非人工提交的身份（指标 srenautix_git_main_unexpected_commits_total 的 actor 标签）。
const (
	ActorSreNautix = "srenautix"
	ActorOtherBot  = "other_bot"
)

// UnexpectedCommit 是 base 分支上的一个非人工提交。
type UnexpectedCommit struct {
	SHA   string
	Actor string
	Why   string
}

// Commit 是 GET /repos/{o}/{r}/commits 返回的一项。
type Commit struct {
	SHA       string   `json:"sha"`
	Author    *Account `json:"author"`
	Committer *Account `json:"committer"`
}

// Commits 返回 branch 上 since 之后的提交（最多 100 个，从新到旧）。
func (r *Repo) Commits(ctx context.Context, branch string, since time.Time) ([]Commit, error) {
	var out []Commit
	q := "?sha=" + url.QueryEscape(branch) + "&since=" + url.QueryEscape(since.UTC().Format(time.RFC3339)) + "&per_page=100"
	return out, r.call(ctx, http.MethodGet, "/commits"+q, nil, &out)
}

// Watchdog 判定 base 分支上的提交是否来自人（main watchdog，ADR 0025）。
type Watchdog struct {
	// AppBot 是 gateway 自己的 App 机器人账号（<slug>[bot]）
	AppBot string
	// AllowedBots 是允许直接写入 base 的机器人账号；不能包含 AppBot
	AllowedBots []string
}

func (w Watchdog) bot(a *Account) bool {
	if a == nil {
		return false
	}
	if a.Login == w.AppBot {
		return true
	}
	if slices.Contains(w.AllowedBots, a.Login) {
		return false
	}
	return a.Type == "Bot" || strings.HasSuffix(a.Login, "[bot]")
}

func (w Watchdog) actor(a *Account) string {
	if a != nil && a.Login == w.AppBot {
		return ActorSreNautix
	}
	return ActorOtherBot
}

// Classify 判定一个提交：author 与 committer 都不是机器人时是人工提交；有一个是机器人时，只有它属于一个已经由人合并的 PR
// （人在网页上合并 srenautix/ 分支的 PR，PR 里的提交由 App 写入）才算人工提交，其余（机器人直接推送、机器人合并 PR）
// 都是非人工提交。返回 nil 表示人工提交。
func (w Watchdog) Classify(ctx context.Context, r *Repo, c Commit) (*UnexpectedCommit, error) {
	if !w.bot(c.Author) && !w.bot(c.Committer) {
		return nil, nil
	}
	who := c.Committer
	if !w.bot(who) {
		who = c.Author
	}
	var pulls []struct {
		Number   int     `json:"number"`
		MergedAt *string `json:"merged_at"`
	}
	if err := r.call(ctx, http.MethodGet, "/commits/"+url.PathEscape(c.SHA)+"/pulls", nil, &pulls); err != nil {
		return nil, err
	}
	var mergers []string
	for _, p := range pulls {
		if p.MergedAt == nil {
			continue
		}
		pr, err := r.GetPR(ctx, p.Number)
		if err != nil {
			return nil, err
		}
		if pr.MergedBy == nil {
			continue
		}
		if !w.bot(pr.MergedBy) {
			return nil, nil
		}
		mergers = append(mergers, fmt.Sprintf("#%d merged by %s", p.Number, pr.MergedBy.Login))
		who = pr.MergedBy
	}
	why := fmt.Sprintf("written by %s without a pull request merged by a person", who.Login)
	if len(mergers) > 0 {
		why = strings.Join(mergers, "; ")
	}
	return &UnexpectedCommit{SHA: c.SHA, Actor: w.actor(who), Why: why}, nil
}
