# API 응답 변경 안내 — v0.3

배포 기준: 2026-04-28

v0.3부터 income API는 Jito Kobe payout API를 사용하지 않습니다. 모든 수입
숫자는 Solana RPC의 블록 데이터에서 직접 계산합니다.

## 핵심 변경

기존 모델:

- slot/fee/mev마다 별도 status가 있었습니다.
- MEV는 `mevRewards*` 필드로 Jito Kobe payout 값을 노출했습니다.
- 진행 중 에폭에서 MEV payout은 아직 공개되지 않아 `no_data`처럼 보일 수
  있었습니다.

새 모델:

- API는 base fees, priority fees, on-chain Jito tips만 노출합니다.
- 진행 중 에폭도 블록 단위로 tips를 집계하므로 `blockTipsTotal*`가 계속
  증가합니다.
- completeness는 status 문자열 대신 boolean으로 판단합니다.

## 그대로 유지되는 엔드포인트

엔드포인트 경로는 그대로입니다.

- `GET /v1/validators/{idOrVote}/current-epoch`
- `GET /v1/validators/{idOrVote}/epochs/{epoch}`
- `GET /v1/validators/{idOrVote}/history`
- `POST /v1/validators/current-epoch/batch`
- `GET /v1/leaderboard`
- `GET /openapi.yaml`

OpenAPI 버전은 `0.3.0`입니다.

## 제거된 필드

`ValidatorEpochRecord`에서 제거:

- `slotsStatus`
- `feesStatus`
- `mevStatus`
- `mevRewardsLamports`
- `mevRewardsSol`
- `sources`
- `freshness.mevUpdatedAt`

`LeaderboardItem`에서 제거:

- `mevRewardsLamports`
- `mevRewardsSol`

이제 Jito Kobe payout을 API 응답에서 별도 reference 값으로 제공하지 않습니다.

## 새 판단 필드

각 epoch row에는 아래 boolean이 있습니다.

| Field            | 의미                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| `isCurrentEpoch` | 현재 진행 중인 epoch row인지 여부입니다.                                  |
| `isFinal`        | epoch이 종료되어 더 이상 증가하지 않는 최종 row인지 여부입니다.           |
| `hasSlots`       | slot 생산 데이터가 수집됐는지 여부입니다. false면 slot 숫자는 null.       |
| `hasIncome`      | block fee/tip 데이터가 수집됐는지 여부입니다. false면 income 숫자는 null. |

클라이언트는 더 이상 `final`, `live`, `no_data`, `not_tracked` 같은 status 문자열을
분기하지 않아야 합니다.

## 수입 필드 정의

| Field                            | 의미                                                |
| -------------------------------- | --------------------------------------------------- |
| `blockBaseFeesTotal*`            | 생산한 블록에서 validator leader가 받은 base fee.   |
| `blockPriorityFeesTotal*`        | 생산한 블록에서 받은 priority fee.                  |
| `blockFeesTotal*`                | `blockBaseFeesTotal* + blockPriorityFeesTotal*`.    |
| `blockTipsTotal*`                | 생산한 블록에서 관측한 on-chain Jito tip transfers. |
| `totalIncome*`                   | `blockFeesTotal* + blockTipsTotal*`.                |
| `medianBlockFee*`                | 해당 validator의 생산 블록별 fee median.            |
| `medianBlockTip*`                | 해당 validator의 생산 블록별 tip median.            |
| `medianBlockTotal*`              | 해당 validator의 생산 블록별 fee + tip median.      |
| `cluster.medianBlockTipLamports` | top-N sample의 per-validator block tip median.      |

`*Lamports`는 항상 string입니다. JavaScript client에서는 `BigInt`나 decimal
library로 파싱해야 합니다.

## Current epoch vs closed epoch

현재 epoch:

- `isCurrentEpoch=true`
- `isFinal=false`
- 숫자는 lower bound입니다.
- worker가 새 블록을 수집할 때 `blockFeesTotal*`, `blockTipsTotal*`,
  `totalIncome*`가 증가할 수 있습니다.

종료된 epoch:

- `isCurrentEpoch=false`
- `isFinal=true`
- 저장된 최종값으로 취급합니다.

누락 row:

- validator는 known이지만 해당 epoch stats row가 없을 수 있습니다.
- 이때 API는 404가 아니라 200을 반환합니다.
- `hasSlots=false`, `hasIncome=false`
- 관련 numeric fields는 `null`

## 응답 예시

`GET /v1/validators/{idOrVote}/current-epoch`

```json
{
  "vote": "5BAi9YGCipHq4ZcXuen5vagRQqRTVTRszXNqBZC6uBPZ",
  "identity": "zeroT6PTAEjipvZuACTh1mbGCqTHgA6i1ped9DcuidX",
  "epoch": 963,
  "isCurrentEpoch": true,
  "isFinal": false,
  "hasSlots": true,
  "hasIncome": true,
  "slotsAssigned": 32,
  "slotsProduced": 13,
  "slotsSkipped": 0,
  "blockFeesTotalLamports": "525653241",
  "blockFeesTotalSol": "0.525653241",
  "blockBaseFeesTotalLamports": "12345678",
  "blockBaseFeesTotalSol": "0.012345678",
  "blockPriorityFeesTotalLamports": "513307563",
  "blockPriorityFeesTotalSol": "0.513307563",
  "blockTipsTotalLamports": "59561432",
  "blockTipsTotalSol": "0.059561432",
  "totalIncomeLamports": "585214673",
  "totalIncomeSol": "0.585214673",
  "lastUpdatedAt": "2026-04-28T10:23:07.559Z",
  "freshness": {
    "slotsUpdatedAt": "2026-04-28T10:23:07.559Z",
    "feesUpdatedAt": "2026-04-28T10:23:07.559Z",
    "tipsUpdatedAt": "2026-04-28T10:23:07.559Z"
  }
}
```

실제 응답에는 median 필드와 cluster 필드도 포함될 수 있습니다.

## 클라이언트 마이그레이션

기존 코드:

```ts
if (row.feesStatus === 'final' || row.feesStatus === 'live') {
  renderIncome(row.blockFeesTotalLamports);
}

if (row.mevStatus === 'final') {
  renderMev(row.mevRewardsLamports);
}
```

새 코드:

```ts
if (row.hasIncome) {
  renderIncome(row.totalIncomeLamports);
  renderBlockFees(row.blockFeesTotalLamports);
  renderBlockTips(row.blockTipsTotalLamports);
}

renderEpochState(row.isFinal ? 'Final' : 'Running');
```

## UI 표시 권장

income 페이지에서는 아래 3개 stream을 기본값으로 보여주면 됩니다.

- Block fees: `blockFeesTotalSol`
- Block tips: `blockTipsTotalSol`
- Total income: `totalIncomeSol`

세부 breakdown이 필요하면:

- Base fees: `blockBaseFeesTotalSol`
- Priority fees: `blockPriorityFeesTotalSol`

`MEV reward`, `Jito payout`, `mevStatus` 같은 용어는 API/UI에서 더 이상
사용하지 않는 것이 좋습니다. 이 프로젝트에서 의미 있는 실시간 MEV 값은
`blockTipsTotal*`입니다.

## 누락 판단과 복구 방식

closed epoch에서 모든 slot을 다시 볼 필요는 없습니다. Solana leader schedule은
epoch 시작 시 이미 결정되어 있으므로, 특정 validator에 대해서는 그 validator가
leader인 slot만 검사하면 됩니다.

검사 순서:

1. `getLeaderSchedule(epoch.firstSlot)`로 watched validator의 leader slots를 구합니다.
2. `processed_blocks`에 해당 leader slot row가 있는지 확인합니다.
3. 없는 slot만 `getBlock`으로 다시 조회해 채웁니다.
4. 마지막에 `epoch_validator_stats`를 delta 누적값이 아니라 `processed_blocks` 합계로
   재계산합니다.

운영 기준:

- `processed_blocks` row가 부족하면 RPC 조회 실패나 worker 중단으로 인한 fact gap입니다.
  missing leader slot만 다시 조회하면 됩니다.
- hot/public RPC가 `null`을 반환한 경우는 primary RPC로 한 번 더 확인한 뒤에만
  skipped slot으로 저장합니다. 따라서 일시적인 public RPC miss가 영구 skipped row로
  고정되는 것을 피합니다.
- `processed_blocks`는 충분한데 API 숫자가 작으면 aggregate drift입니다. RPC 호출 없이
  `processed_blocks` 합계로 `epoch_validator_stats`를 재계산하면 됩니다.
- worker의 `income-reconciler` job은 최신 closed epoch에 대해 이 과정을 주기적으로
  수행합니다. 기본 주기는 `CLOSED_EPOCH_RECONCILE_INTERVAL_MS=300000`입니다.
- live worker는 더 이상 archive RPC로 `getBlockProduction`/`getBlock`을 우회하지 않습니다.
  slot counters는 `processed_blocks`에서 계산하고, block fetch는 watched validator의
  leader slot에 대해서만 primary RPC를 사용합니다.
- 예비 live RPC가 필요하면 `solanaFallbackRpcUrl` / `SOLANA_FALLBACK_RPC_URL`을
  사용합니다. primary가 먼저이고 fallback은 primary error 후에만 사용됩니다.

## 배포 확인 체크리스트

배포 후 아래를 확인합니다.

```bash
curl -fsS https://whoearns.live/openapi.yaml | head
curl -fsS https://whoearns.live/v1/epoch/current
curl -fsS https://whoearns.live/v1/validators/<vote-or-identity>/current-epoch
```

정상 배포 기준:

- OpenAPI `info.version`이 `0.3.0`
- validator row에 `isCurrentEpoch`, `isFinal`, `hasSlots`, `hasIncome` 존재
- `totalIncomeLamports` 존재
- `mevStatus`, `mevRewardsLamports`, `slotsStatus`, `feesStatus`, `sources` 없음
