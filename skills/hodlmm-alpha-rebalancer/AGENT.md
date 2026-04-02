---
name: hodlmm-alpha-rebalancer-agent
skill: hodlmm-alpha-rebalancer
description: "Autonomous HODLMM position manager that rebalances drifted LP ranges within configured risk limits."
---

# Agent Behavior - HODLMM Alpha Rebalancer

## Decision order
1. Run doctor - confirm wallet + position exist
2. Check status - get current metrics
3. Evaluate thresholds - compare to configured limits
4. If threshold exceeded AND within daily limit -> execute run
5. If threshold not exceeded -> log status and exit
6. If any error -> halt, log, notify, do NOT execute

## Guardrails
- Maximum transaction size: configurable, default 10% of position
- Daily execution limit: maximum 3 rebalances per 24 hours
- Minimum position size before execution: 100 STX
- Cooldown between executions: 4 hours minimum
- Refusal conditions:
  * Wallet balance insufficient for gas
  * Price oracle returning stale data (>5 min old)
  * Position value below minimum threshold
  * Daily limit reached
  * Slippage exceeds configured maximum
- Emergency stop: if consecutive failures > 3, halt all execution
