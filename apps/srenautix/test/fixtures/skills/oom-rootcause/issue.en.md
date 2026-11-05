## Symptoms

StatefulSet `api-gateway` (namespace `shop`, limit 4.0 GiB, GOMEMLIMIT 3865470566, GOMAXPROCS=2, image `registry.example/api-gateway:1.42.0`) had 3 memory kills in the last 48h:

| Time (UTC) | Pod | Kind | Notes |
|---|---|---|---|
| 11-01 07:53:00 | api-gateway-0 | container limit | the live heap sat at GOMEMLIMIT and continuous GC could not reclaim it: the memory is live data; memory peak 3.3 GiB, container CPU peaked at 1.15 cores (57% of GOMAXPROCS 2) |
| 11-02 00:09:14 | api-gateway-3 | container limit | the live heap sat at GOMEMLIMIT and continuous GC could not reclaim it: the memory is live data; memory peak 3.3 GiB, container CPU peaked at 1.1 cores (55% of GOMAXPROCS 2) |
| 11-02 00:44:22 | api-gateway-0 | container limit | the live heap sat at GOMEMLIMIT and continuous GC could not reclaim it: the memory is live data; memory peak 3.3 GiB, container CPU peaked at 1.1 cores (55% of GOMAXPROCS 2) |

Conclusion (main / secondary / confidence):

- **Main cause (confidence medium-high)**: Large request bodies converted and appended whole. Large request bodies are decoded whole and appended whole when archived; concurrent ones add up beyond the budget headroom.
- **Another trigger (confidence medium)**: api-gateway-0 11-01 07:53:00 was driven by Non-retryable rejections retried. Non-retryable upstream rejections are retried and every attempt grows the same archive record.
- **Not supported by statistics (not ruled out)**: Export task memory watchdog, possibly an aggravating factor, see §3.

## 1. Evidence

| Time (UTC) | Pod | Metric / log | Value | Basis | Query |
|---|---|---|---|---|---|
| 11-01 07:53:00 | api-gateway-0 | heap_inuse / GOMEMLIMIT | 828 MiB → 3.3 GiB / 3.6 GiB | observed | `go-runtime/heap_inuse{namespace="shop"}` |
| 11-01 07:53:00 | api-gateway-0 | RSS / limit | 3.8 GiB / 4.0 GiB | observed | `workload/container_memory_rss{namespace="shop"}` |
| 11-01 07:53:00 | api-gateway-0 | container CPU (for GC CPU) | container CPU peaked at 1.15 cores (57% of GOMAXPROCS 2) | inferred (proxy) | `workload/container_cpu_cores{namespace="shop"}` |
| 11-01 07:53:00 | api-gateway-0 | node memory available | 55.0% | observed | `workload/pod_node_memory_available{namespace="shop"}` |
| 11-02 00:09:14 | api-gateway-3 | heap_inuse / GOMEMLIMIT | 811 MiB → 3.3 GiB / 3.6 GiB | observed | `go-runtime/heap_inuse{namespace="shop"}` |
| 11-02 00:09:14 | api-gateway-3 | RSS / limit | 3.8 GiB / 4.0 GiB | observed | `workload/container_memory_rss{namespace="shop"}` |
| 11-02 00:09:14 | api-gateway-3 | container CPU (for GC CPU) | container CPU peaked at 1.1 cores (55% of GOMAXPROCS 2) | inferred (proxy) | `workload/container_cpu_cores{namespace="shop"}` |
| 11-02 00:09:14 | api-gateway-3 | node memory available | 55.0% | observed | `workload/pod_node_memory_available{namespace="shop"}` |
| 11-02 00:44:22 | api-gateway-0 | heap_inuse / GOMEMLIMIT | 787 MiB → 3.3 GiB / 3.6 GiB | observed | `go-runtime/heap_inuse{namespace="shop"}` |
| 11-02 00:44:22 | api-gateway-0 | RSS / limit | 3.8 GiB / 4.0 GiB | observed | `workload/container_memory_rss{namespace="shop"}` |
| 11-02 00:44:22 | api-gateway-0 | container CPU (for GC CPU) | container CPU peaked at 1.1 cores (55% of GOMAXPROCS 2) | inferred (proxy) | `workload/container_cpu_cores{namespace="shop"}` |
| 11-02 00:44:22 | api-gateway-0 | node memory available | 55.0% | observed | `workload/pod_node_memory_available{namespace="shop"}` |
| 11-01 07:23–07:53 | api-gateway-0 | Active requests | 23 → 2 (peak 29) | observed | `shop/active_requests{namespace="shop"}` |
| 11-01 07:23–07:53 | api-gateway-0 | Body conversion bytes | 3.8 MiB/s → 488 KiB/s (peak 4.6 MiB/s) | observed | `shop/body_bytes_rate{namespace="shop"}` |
| 11-01 07:23–07:53 | api-gateway-0 | Archive log backlog | 50.3 MiB → 198 MiB (peak 198 MiB) | observed | `shop/archive_backlog_bytes{namespace="shop"}` |
| 11-01 07:23–07:53 | api-gateway-0 | Export deferrals | 0.03/s → 0/s (peak 0.03/s) | observed | `shop/export_deferred_rate{namespace="shop"}` |
| 11-01 23:39–11-02 00:09 | api-gateway-3 | Active requests | 24 → 7 (peak 29) | observed | `shop/active_requests{namespace="shop"}` |
| 11-01 23:39–11-02 00:09 | api-gateway-3 | Body conversion bytes | 3.7 MiB/s → 113 MiB/s (peak 113 MiB/s) | observed | `shop/body_bytes_rate{namespace="shop"}` |
| 11-01 23:39–11-02 00:09 | api-gateway-3 | Archive log backlog | 52.6 MiB → 1.4 GiB (peak 1.4 GiB) | observed | `shop/archive_backlog_bytes{namespace="shop"}` |
| 11-01 23:39–11-02 00:09 | api-gateway-3 | Export deferrals | 0/s → 0.045/s (peak 0.045/s) | observed | `shop/export_deferred_rate{namespace="shop"}` |
| 11-02 00:14–00:44 | api-gateway-0 | Active requests | 23 → 6 (peak 29) | observed | `shop/active_requests{namespace="shop"}` |
| 11-02 00:14–00:44 | api-gateway-0 | Body conversion bytes | 3.4 MiB/s → 104 MiB/s (peak 104 MiB/s) | observed | `shop/body_bytes_rate{namespace="shop"}` |
| 11-02 00:14–00:44 | api-gateway-0 | Archive log backlog | 52.1 MiB → 1.1 GiB (peak 1.1 GiB) | observed | `shop/archive_backlog_bytes{namespace="shop"}` |
| 11-02 00:14–00:44 | api-gateway-0 | Export deferrals | 0/s → 0.043/s (peak 0.043/s) | observed | `shop/export_deferred_rate{namespace="shop"}` |
| 11-01 07:35–07:44 | api-gateway-0 | upstream_failure_not_retryable | 89 lines, status_code max 400 | observed | `{pod=~".+"} \|= "executor_upstream_failure"` |
| 11-01 23:43–11-02 00:41 | api-gateway-0, api-gateway-3 | request_end | 11 lines, duration_ms max 11.9 min, request_body_bytes max 50.3 MiB | observed | `{pod=~".+"} \|= "request_end"` |
| 11-02 00:07–00:43 | api-gateway-0, api-gateway-3 | request_body_budget_tuned | 3 lines, live_heap_bytes max 2.6 GiB, held_bytes max 1006 MiB, memory_budget_bytes max 2.6 GiB | observed | `{pod=~".+"} \|= "request_body_budget_tuned"` |
| 11-02 00:08–00:43 | api-gateway-0, api-gateway-3 | archive_spool_full | 2 lines, log_usage_bytes max 2.1 GiB, log_budget_bytes max 2.0 GiB | observed | `{pod=~".+"} \|= "request_archive_spool_full"` |
| 10-31 12:00–11-02 12:00 | all | Body conversion bytes vs high memory | support 59.0%, lift 22.7, counter 41.0%, corr 0.87, lead 0.83 / lag 0.75 | inferred (statistics) | `shop/body_bytes_rate{namespace="shop"}` |
| 10-31 12:00–11-02 12:00 | all | Archive log backlog vs high memory | support 67.1%, lift 25.8, counter 32.9%, corr 0.88, lead 0.83 / lag 0.75 | inferred (statistics) | `shop/archive_backlog_bytes{namespace="shop"}` |
| 10-31 12:00–11-02 12:00 | all | Export deferrals vs high memory | support 0.0%, lift 0, counter 100.0%, corr 0.25, lead 0.21 / lag 0.24 | inferred (statistics) | `shop/export_deferred_rate{namespace="shop"}` |

Large requests in the main group (request_id, organization prefix and numbers only; most request body bytes: organization 7f3c9a2b… (91%)):

| Time (UTC) | Pod | request_id | Organization | Path | Body | Duration |
|---|---|---|---|---|---|---|
| 11-02 00:28:09 | api-gateway-0 | `01940049-0000-7000-8000-000000000049` | `7f3c9a2b…` | `/v1/responses` | 50.3 MiB | 9.8 min |
| 11-01 23:58:05 | api-gateway-3 | `01940045-0000-7000-8000-000000000045` | `7f3c9a2b…` | `/v1/responses` | 48.9 MiB | 6.7 min |
| 11-02 00:09:01 | api-gateway-3 | `01940099-0000-7000-8000-000000000099` | `7f3c9a2b…` | `/v1/responses` | 45.0 MiB | 5.0 min |
| 11-02 00:06:12 | api-gateway-3 | `01940047-0000-7000-8000-000000000047` | `7f3c9a2b…` | `/v1/responses` | 44.0 MiB | 3.9 min |
| 11-02 00:41:02 | api-gateway-0 | `01940052-0000-7000-8000-000000000052` | `7f3c9a2b…` | `/v1/responses` | 42.0 MiB | 2.7 min |
| 11-01 23:51:40 | api-gateway-3 | `01940044-0000-7000-8000-000000000044` | `7f3c9a2b…` | `/v1/responses` | 40.0 MiB | 8.5 min |
| 11-02 00:33:51 | api-gateway-0 | `01940050-0000-7000-8000-000000000050` | `7f3c9a2b…` | `/v1/responses` | 38.0 MiB | 5.2 min |
| 11-02 00:21:44 | api-gateway-0 | `01940048-0000-7000-8000-000000000048` | `7f3c9a2b…` | `/v1/responses` | 34.0 MiB | 10.9 min |
| 11-01 23:43:10 | api-gateway-3 | `01940043-0000-7000-8000-000000000043` | `7f3c9a2b…` | `/v1/responses` | 33.1 MiB | 11.9 min |
| 11-02 00:38:27 | api-gateway-0 | `01940051-0000-7000-8000-000000000051` | `c0ffee12…` | `/v1beta/models/m:streamGenerateContent` | 20.0 MiB | 3.2 min |

## 2. Mechanism and code

- **Large request bodies converted and appended whole** (main cause): Large request bodies are decoded whole and appended whole when archived; concurrent ones add up beyond the budget headroom (inferred, declared by the pack)
- **Non-retryable rejections retried** (another trigger): Non-retryable upstream rejections are retried and every attempt grows the same archive record (inferred, declared by the pack)
- **Export task memory watchdog** (not supported by statistics): The watchdog measures process heap objects and counts other requests' garbage against the export task (inferred, declared by the pack)

## 3. Ruled out and statistical counter-examples

Only direct evidence that the mechanism was absent at the kills rules a suspect out; a missing statistical association only means it is not supported and rules nothing out.

- **Export task memory watchdog** (not supported by statistics, not ruled out): of the 43 samples in 48 h where "Export deferrals" was high, 100.0% had memory that was not high (counter-examples), lift 0; no statistical association is not a rule-out: averaged or step-sampled series smooth over the spike of a single request, and nothing at the occurrences contradicts it; it was still rising in the last 2 minutes before the main group occurrences, possibly the last straw (inferred).

## 4. Fixes and operations options

Code (suspects not ruled out):

- [ ] Stream large bodies or convert once per request
- [ ] Preallocate archive writes and cap cached results
- [ ] Stop retrying non-retryable 400s
- [ ] Count per-task bytes in the watchdog

Operations options (listed only, not executed; a human decides):

| Option | Domain | Impact | Benefit | Risk |
|---|---|---|---|---|
| Lower the per-request conversion limit | Gateway admission | Oversized requests get 413 | Bounds conversion memory per request | Business-visible; long-context requests fail |
| Raise the memory limit | StatefulSet resources | Node allocation (request equals limit) | Higher OOM threshold | Needs a node capacity review; the mechanism remains |
| Move all exports to the exporter process | Export placement | The gateway no longer runs exports | No export allocations in the gateway | The exporter must be sized |

## 5. Not verified

- api-gateway-0 11-01 07:53:00: no GC CPU metric; container CPU is used as the sign of continuous GC
- api-gateway-3 11-02 00:09:14: no GC CPU metric; container CPU is used as the sign of continuous GC
- api-gateway-0 11-02 00:44:22: no GC CPU metric; container CPU is used as the sign of continuous GC
- the mechanism of "Large request bodies converted and appended whole" is declared by the pack; its link to metrics and logs is statistical and was not verified at runtime
- the mechanism of "Non-retryable rejections retried" is declared by the pack; its link to metrics and logs is statistical and was not verified at runtime
- Which objects fill the heap needs a heap profile. Retained profiles (SreNautix does not fetch them):
  - api-gateway-0 (11-02 06:37:22): `/var/lib/app/heap-profiles/heap-20261102T063722Z-2883MiB.pb.gz`; fetch: `kubectl -n shop cp api-gateway-0:/var/lib/app/heap-profiles/heap-20261102T063722Z-2883MiB.pb.gz ./heap-20261102T063722Z-2883MiB.pb.gz -c gateway`; analyze: `go tool pprof -sample_index=inuse_space -top heap-20261102T063722Z-2883MiB.pb.gz`
  - api-gateway-0 (11-02 00:43:50): `/var/lib/app/heap-profiles/heap-20261102T004350Z-3290MiB.pb.gz`; fetch: `kubectl -n shop cp api-gateway-0:/var/lib/app/heap-profiles/heap-20261102T004350Z-3290MiB.pb.gz ./heap-20261102T004350Z-3290MiB.pb.gz -c gateway`; analyze: `go tool pprof -sample_index=inuse_space -top heap-20261102T004350Z-3290MiB.pb.gz`
  - api-gateway-3 (11-02 06:17:24): `/var/lib/app/heap-profiles/heap-20261102T061724Z-2330MiB.pb.gz`; fetch: `kubectl -n shop cp api-gateway-3:/var/lib/app/heap-profiles/heap-20261102T061724Z-2330MiB.pb.gz ./heap-20261102T061724Z-2330MiB.pb.gz -c gateway`; analyze: `go tool pprof -sample_index=inuse_space -top heap-20261102T061724Z-2330MiB.pb.gz`

Related: #98 #101 #104 #107 

---
Generated read-only by SreNautix skill oom-rootcause 1.0.0 (digest `sha256:fixture`, run [00000000-0000-4000-8000-000000000001](https://srenautix.example.test/skills/runs/00000000-0000-4000-8000-000000000001)); recurrences of the same root cause are added here as comments.
