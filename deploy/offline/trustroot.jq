# 把 Sigstore 的 trusted_root.json 转成 policy-controller 的 TrustRoot（policy.sigstore.dev/v1alpha1）。
# 用法：jq -f trustroot.jq --arg name <TrustRoot 名称> trusted_root.json
def pem(kind): "-----BEGIN \(kind)-----\n" + . + "\n-----END \(kind)-----\n";
def chain: [.certChain.certificates[].rawBytes | pem("CERTIFICATE")] | join("");
def hashalg: if . == "SHA2_256" then "sha-256" elif . == "SHA2_384" then "sha-384" elif . == "SHA2_512" then "sha-512" else error("未知的哈希算法 \(.)") end;
def authority: {
  subject: {organization: (.subject.organization // ""), commonName: (.subject.commonName // "")},
  uri: .uri,
  certChain: chain
};
def logkey: {
  baseURL: .baseUrl,
  hashAlgorithm: (.hashAlgorithm | hashalg),
  publicKey: (.publicKey.rawBytes | pem("PUBLIC KEY"))
};
{
  apiVersion: "policy.sigstore.dev/v1alpha1",
  kind: "TrustRoot",
  metadata: {name: $name},
  spec: {
    sigstoreKeys: {
      certificateAuthorities: [.certificateAuthorities[] | authority],
      tLogs: [.tlogs[] | logkey],
      ctLogs: [.ctlogs[] | logkey],
      timestampAuthorities: [(.timestampAuthorities // [])[] | authority]
    }
  }
}
