# 节点

## NotReady 与资源压力

1. 看 `Ready 与资源压力` 卡：NotReady 的起始时间与内存、磁盘、PID 压力是否同时出现。
2. 内存压力：看 `CPU 与内存` 卡和 `同节点 CPU 用量最大的 Pod` 卡，找出占用最多的 Pod。
3. kubelet 掉线而节点本身在线：查 kubelet 日志（`journalctl -u kubelet`，RKE2 为 `rke2-server` 或 `rke2-agent`）。

## 文件系统

- 根盘余量低：常见来源是容器镜像、容器日志、emptyDir、local-path 卷。`crictl rmi --prune` 清理未用镜像。
- 只读：通常是文件系统错误或底层磁盘故障，先迁走有状态负载再处理磁盘。
- 磁盘忙：同一块盘上的 etcd、数据库与日志写入互相影响。

## 网络与时钟

- 网卡错误持续增长：检查网线、交换机端口与网卡驱动。
- conntrack 将满：调大 `nf_conntrack_max`，或找出建立大量短连接的 Pod。
- 时钟未同步：检查 chrony 或 systemd-timesyncd；时钟偏差会导致证书校验和 etcd 选举异常。

## 处置

动作目录中的 `node_cordon` 可以阻止新 Pod 调度到问题节点，撤销方式是 `node_uncordon`。
