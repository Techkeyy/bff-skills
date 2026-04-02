---
name: hodlmm-alpha-rebalancer
description: "Autonomously detects HODLMM LP drift and executes guarded rebalances within configurable risk limits."
metadata:
  author: "Praise_Prodigyy"
  author-agent: "Binary Warden"
  user-invocable: "false"
  arguments: "doctor | status | run | configure"
  entry: "hodlmm-alpha-rebalancer/hodlmm-alpha-rebalancer.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, hodlmm, bitflow, mainnet-only, rebalance"
---

# HODLMM Alpha Rebalancer

## What this skill does
HODLMM Alpha Rebalancer continuously evaluates a Bitflow HODLMM position versus live active-bin conditions and determines whether rebalance is required. When thresholds are breached and all safety gates pass, it executes a rebalance flow and returns transaction proof. The skill is designed for autonomous operation with strict limits, cooldowns, and refusal logic.

## Prerequisites
- AIBTC wallet configured and accessible
- Active Bitflow HODLMM position on mainnet
- Sufficient STX balance for gas

## Arguments

### doctor
Runs a full readiness check for wallet, network, API reachability, and position visibility.

```bash
bun run skills/hodlmm-alpha-rebalancer/hodlmm-alpha-rebalancer.ts doctor
```

### status
Shows current position metrics, drift, accrued yield estimate, and whether rebalance is required.

```bash
bun run skills/hodlmm-alpha-rebalancer/hodlmm-alpha-rebalancer.ts status --pool-id dlmm_1
```

### run
Executes autonomous rebalance only if all guardrails pass. Use `--dry-run` to simulate.

```bash
bun run skills/hodlmm-alpha-rebalancer/hodlmm-alpha-rebalancer.ts run --pool-id dlmm_1 --dry-run
bun run skills/hodlmm-alpha-rebalancer/hodlmm-alpha-rebalancer.ts run --pool-id dlmm_1
```

### configure
Sets or reads thresholds and execution limits.

```bash
bun run skills/hodlmm-alpha-rebalancer/hodlmm-alpha-rebalancer.ts configure --drift-threshold 12 --daily-limit 3 --min-position 100 --cooldown-hours 4
bun run skills/hodlmm-alpha-rebalancer/hodlmm-alpha-rebalancer.ts configure
```

## Example output

```json
{
  "status": "success",
  "tx_hash": "0xabc123...",
  "action": "rebalance",
  "data": {
    "pool_id": "dlmm_1",
    "drift_pct": 22.5,
    "slippage_pct": 0.41,
    "position_value_stx": 248.17,
    "cooldown_hours_remaining": 0,
    "daily_executions": 1
  }
}
```

## Safety
- Maximum transaction size is configurable, default 10% of position value
- Daily execution limit is configurable, default 3 per 24 hours
- Minimum position size before execution is 100 STX by default
- Cooldown between executions is 4 hours by default
- Refuses execution when wallet gas balance is insufficient
- Refuses execution when oracle/data freshness is older than 5 minutes
- Refuses execution when position value is below minimum threshold
- Refuses execution when daily execution limit is reached
- Refuses execution when slippage exceeds configured maximum
- Emergency stop triggers after more than 3 consecutive failures
- All errors return JSON in this format: { "error": "descriptive message" }
