# WhoEarns Helm chart

Runtime chart name: `whoearns-live`. Installing with release name
`whoearns-live` creates Kubernetes objects with the public runtime slug,
including StatefulSet `whoearns-live` and pod `whoearns-live-0`.

Chart version: `0.4.0` · App version: `0.4.0`

Single-pod deployment. The image bundles PostgreSQL 16, so one StatefulSet
with one replica runs the API, the worker, and Postgres in the same
container. Migrations run automatically on pod start.

## Components

| Kind           | Name              | Purpose                                                                                                    |
| -------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| StatefulSet    | `<rel>`           | API + worker + Postgres in one container                                                                   |
| Service        | `<rel>`           | ClusterIP for the API (adds a `metrics` port when `config.metricsPort` > 0)                                |
| Service        | `<rel>-headless`  | Governing service for the StatefulSet                                                                      |
| ConfigMap      | `<rel>-config`    | Non-secret env vars                                                                                        |
| Secret         | `<rel>-anthropic` | Anthropic API key — rendered ONLY when `anthropic.apiKey` is set inline (see below)                        |
| ServiceMonitor | `<rel>`           | Prometheus Operator scrape target — rendered ONLY when `serviceMonitor.enabled` + `config.metricsPort` > 0 |
| ServiceAccount | `<rel>`           | Pod identity                                                                                               |
| Ingress        | `<rel>`           | Disabled by default; enable per overlay                                                                    |

PostgreSQL state lives on the PVC `data-<rel>-0` created by
`volumeClaimTemplates`.

## Install

### Minimal — your own cluster, no ingress

```bash
helm --kube-context <your-context> upgrade --install whoearns-live \
  deploy/helm/whoearns-live \
  -n <your-ns> --create-namespace \
  --set image.repository=<your-dockerhub-user>/whoearns-live \
  --set config.validatorsWatchList='Vote111...,Vote222...'
```

Reach the API via `kubectl port-forward svc/whoearns-live 8080:8080`.

### Pulling from a private registry

```bash
kubectl --context <your-context> -n <your-ns> create secret docker-registry regcred \
  --docker-server=https://index.docker.io/v1/ \
  --docker-username=<user> --docker-password=<pat> \
  --docker-email=<email>

helm --kube-context <your-context> upgrade --install whoearns-live \
  deploy/helm/whoearns-live \
  -n <your-ns> --create-namespace \
  --set imagePullSecrets[0].name=regcred \
  ...
```

### Your own production deployment

For a stable deployment keep a gitignored `deploy.sh` at the repo root
with your org's Helm overrides embedded. The repo ignores
`build.sh`, `deploy.sh`, and any `deploy/helm/**/values-*.yaml`
overlay so nothing organization-specific leaks into the OSS tree.

Typical pattern (heredoc overlay piped into helm via a temp file):

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${SOLANA_RPC_URL:?set SOLANA_RPC_URL to your paid RPC endpoint}"

tmp_values=$(mktemp)
trap 'rm -f "$tmp_values"' EXIT
cat > "$tmp_values" <<'EOF'
image:
  repository: <your-dockerhub-user>/whoearns-live
imagePullSecrets:
  - name: regcred
ingress:
  enabled: true
  className: nginx
  annotations:
    external-dns.alpha.kubernetes.io/hostname: validator-explorer.example.com
  hosts:
    - host: validator-explorer.example.com
      paths:
        - path: /
          pathType: Prefix
config:
  yellowstoneGrpcUrl: https://solana-yellowstone-grpc.publicnode.com
  solanaRpcCreditsPerSec: 2500
  solanaRpcBurstCredits: 5000
  validatorsWatchList: 'Vote111...,Vote222...'
EOF

helm --kube-context <your-context> upgrade --install whoearns-live \
  deploy/helm/whoearns-live \
  -n default \
  -f "$tmp_values" \
  --set config.solanaRpcUrl="$SOLANA_RPC_URL"
```

Keep the RPC URL in your shell env (or a local `.envrc`) rather than
the script so you don't accidentally commit the provider token.

## Values reference

See `values.yaml` for the full, commented reference. Highlights:

- `image.repository` default is `your-dockerhub-user/whoearns-live`
  — override for any real deployment. `image.tag` defaults to `latest` and
  `image.pullPolicy` defaults to `Always` so every `helm upgrade` pulls
  fresh. For audit-grade stability, pin a SHA tag in your overlay.
- `imagePullSecrets` is empty by default; set it for private registries.
- `ingress.enabled` defaults to `false`. Production overlays can turn it on
  with annotations for external-dns, Cloudflare, or your own DNS controller.
- `persistence.size` / `.storageClass` controls the PVC backing Postgres.
- `postgres.user` / `.password` / `.database` are baked into the data
  directory at first boot. Changing them later does **not** rotate the
  role password — uninstall + restore from dump if you need to rotate.
- `config.solanaFallbackRpcUrl` is optional live-worker backup RPC. The
  worker tries `config.solanaRpcUrl` first and only uses fallback after
  primary retries fail.
- `config.solanaArchiveRpcUrl` is not used by the live worker for
  `getBlockProduction` or `getBlock`; leave it empty for normal deploys.
  It is retained for one-shot/offline refill scripts.
- `config.*` flattens onto env vars via the ConfigMap.

### Gamification feature flags (Phases 2-6)

These drive the worker job cadences for the badge / tier / claim /
wallet-activity / SIMD-curation features. All have safe defaults — a
deployment that doesn't `--set` any of them still runs every job at
the documented interval.

| Value                             | Env var                       | Default             | Drives                                                   |
| --------------------------------- | ----------------------------- | ------------------- | -------------------------------------------------------- |
| `config.clusterNodesIntervalMs`   | `CLUSTER_NODES_INTERVAL_MS`   | `1800000`           | Phase 2 gossip ContactInfo refresh (client-kind/version) |
| `config.validatorInfoIntervalMs`  | `VALIDATOR_INFO_INTERVAL_MS`  | `21600000`          | Phase 2 on-chain validator-info refresh (watched set)    |
| `config.walletActivityIntervalMs` | `WALLET_ACTIVITY_INTERVAL_MS` | `21600000`          | Phase 4 wallet daily-activity indexer                    |
| `config.simdCurationIntervalMs`   | `SIMD_CURATION_INTERVAL_MS`   | `43200000`          | Phase 5 SIMD AI-curation pass                            |
| `anthropic.model`                 | `ANTHROPIC_MODEL`             | `claude-sonnet-4-6` | Phase 5 model identifier (non-secret; ConfigMap)         |

> The large interval values are deliberately QUOTED strings in
> `values.yaml` — Helm widens bare integers to float64, which would
> render `1800000` as `"1.8e+06"`. Keep the quotes if you override.

### Anthropic API key (Phase 5 — optional)

The SIMD curation pipeline needs an Anthropic API key. When unset the
pipeline is simply disabled (the public read endpoint still serves
already-curated rows). The key is **never** placed in the ConfigMap —
two Secret-based wirings:

- **Inline (dev / fork demo).** `--set anthropic.apiKey=sk-ant-...`
  — the chart provisions a Secret named `<rel>-anthropic` holding the
  value and the StatefulSet references it.
- **External Secret (production).** Pre-create a Secret in the release
  namespace with key `ANTHROPIC_API_KEY`, then
  `--set anthropic.existingSecret=<secret-name>`. The chart references
  it via `secretKeyRef` and does NOT manage it — pairs with
  external-secrets / sealed-secrets / cloud KMS injection.

`anthropic.apiKey` and `anthropic.existingSecret` are mutually
exclusive — set one, not both.

### Prometheus ServiceMonitor (optional)

`serviceMonitor.enabled: true` (with `config.metricsPort` > 0) renders
a `monitoring.coreos.com/v1` ServiceMonitor for selector-based
Prometheus Operator discovery. It's independent of the
`prometheus.io/scrape` pod annotations the StatefulSet already emits —
most clusters use one mechanism or the other. Requires the
monitoring.coreos.com CRDs. Set `serviceMonitor.labels.release` to
match your Prometheus Operator's ServiceMonitor selector.

## Ingress with external-dns + Cloudflare (example)

If your cluster runs `ingress-nginx` + `external-dns` against a
Cloudflare zone, enable the ingress and set the hostname annotation
in your overlay (see the deploy-script template above).

- hostname: set via `ingress.hosts[0].host` and
  `external-dns.alpha.kubernetes.io/hostname` annotation.
- TLS: if Cloudflare terminates TLS in front of the cluster, leave
  `tls: []` so the pod only serves HTTP.
- Prerequisite: `external-dns` configured for your DNS zone.

## Data persistence and upgrades

### `helm uninstall` does NOT delete the PVC

StatefulSet PVCs survive `helm uninstall` by design. `kubectl delete
ns <ns>` does **not** — namespace deletion cascades to PVCs. Back up
first.

### PVC retention across uninstall

To guarantee the PVC survives aggressive cleanup:

```bash
kubectl --context <your-context> -n <your-ns> annotate pvc \
  data-whoearns-live-0 helm.sh/resource-policy=keep
```

### Backup

```bash
kubectl --context <your-context> -n <your-ns> exec whoearns-live-0 -- \
  su-exec postgres pg_dump -U indexer -d indexer \
  | gzip > whoearns-live-$(date +%Y%m%dT%H%M%S).sql.gz
```

### Restore

```bash
gunzip -c whoearns-live-YYYYMMDDTHHMMSS.sql.gz | \
  kubectl --context <your-context> -n <your-ns> exec -i whoearns-live-0 -- \
    su-exec postgres psql -U indexer -d indexer
```

### Major Postgres version upgrade

A future image update that bumps the embedded Postgres major version
(16 → 17) will refuse to start on the existing data directory. The
upgrade path is dump → delete PVC → install new image → restore:

```bash
CTX=--context=<your-context>
NS=<your-ns>
POD=whoearns-live-0
PVC=data-$POD

kubectl $CTX -n $NS exec $POD -- \
  su-exec postgres pg_dump -U indexer -d indexer -Fc > /tmp/backup.dump

helm --kube-context <your-context> uninstall whoearns-live -n $NS
kubectl $CTX -n $NS delete pvc $PVC

helm --kube-context <your-context> upgrade --install whoearns-live \
  deploy/helm/whoearns-live -n $NS
# wait for the new pod to finish initdb

kubectl $CTX -n $NS cp /tmp/backup.dump $POD:/tmp/backup.dump
kubectl $CTX -n $NS exec $POD -- \
  su-exec postgres pg_restore -U indexer -d indexer /tmp/backup.dump
```

## Test

```bash
helm --kube-context <your-context> test whoearns-live -n <your-ns>
```

Runs a Pod that curls `http://<rel>:<port>/healthz`.
