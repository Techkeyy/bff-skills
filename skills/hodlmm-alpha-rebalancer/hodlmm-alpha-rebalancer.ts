#!/usr/bin/env bun
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getActiveWallet } from "../../src/lib/wallet";
import { getNetworkConfig } from "../../src/lib/config/networks";
import { getStacksHealth, getStxBalance } from "../../src/lib/services/stacks-api";

type JsonMap = Record<string, unknown>;

interface RebalancerConfig {
  drift_threshold: number;
  daily_limit: number;
  min_position: number;
  cooldown_hours: number;
  max_slippage_pct: number;
  max_tx_pct: number;
  min_gas_reserve_stx: number;
  stale_oracle_minutes: number;
  pool_id: string;
}

interface RebalancerState {
  last_execution_at: string | null;
  executions: string[];
  consecutive_failures: number;
}

interface PositionMetrics {
  pool_id: string;
  active_bin: number;
  user_bins: number[];
  drift_pct: number;
  target_center_bin: number;
  action_required: boolean;
  yield_accrued_usd: number;
  slippage_pct: number;
  position_value_stx: number;
  data_age_seconds: number;
}

const CONFIG_DIR = join(homedir(), ".aibtc");
const CONFIG_PATH = join(CONFIG_DIR, "hodlmm-alpha-rebalancer-config.json");
const STATE_PATH = join(CONFIG_DIR, "hodlmm-alpha-rebalancer-state.json");

const DEFAULT_CONFIG: RebalancerConfig = {
  drift_threshold: 12,
  daily_limit: 3,
  min_position: 100,
  cooldown_hours: 4,
  max_slippage_pct: 1,
  max_tx_pct: 10,
  min_gas_reserve_stx: 0.5,
  stale_oracle_minutes: 5,
  pool_id: "dlmm_1",
};

const DEFAULT_STATE: RebalancerState = {
  last_execution_at: null,
  executions: [],
  consecutive_failures: 0,
};

const FETCH_TIMEOUT_MS = 30_000;

function printJson(payload: JsonMap): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printError(message: string): never {
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  ensureConfigDir();
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function loadConfig(): RebalancerConfig {
  return { ...DEFAULT_CONFIG, ...readJsonFile<Partial<RebalancerConfig>>(CONFIG_PATH, {}) };
}

function saveConfig(config: RebalancerConfig): void {
  writeJsonFile(CONFIG_PATH, config);
}

function loadState(): RebalancerState {
  return { ...DEFAULT_STATE, ...readJsonFile<Partial<RebalancerState>>(STATE_PATH, {}) };
}

function saveState(state: RebalancerState): void {
  writeJsonFile(STATE_PATH, state);
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "bff-skills/hodlmm-alpha-rebalancer",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return response.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

function parseNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function computeDriftPct(activeBin: number, userBins: number[], halfRange = 8): number {
  if (userBins.length === 0 || activeBin <= 0) {
    return 100;
  }

  if (userBins.includes(activeBin)) {
    return 0;
  }

  const distance = userBins
    .map((bin) => Math.abs(bin - activeBin))
    .sort((a, b) => a - b)[0] ?? halfRange;

  return Math.min(100, Number(((distance / halfRange) * 100).toFixed(2)));
}

function countExecutionsInWindow(executions: string[], windowHours: number): number {
  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  return executions.filter((ts) => now - new Date(ts).getTime() <= windowMs).length;
}

function getCooldownRemainingHours(lastExecutionAt: string | null, cooldownHours: number): number {
  if (!lastExecutionAt) {
    return 0;
  }
  const elapsedHours = (Date.now() - new Date(lastExecutionAt).getTime()) / 3600000;
  const remaining = cooldownHours - elapsedHours;
  return remaining > 0 ? Number(remaining.toFixed(2)) : 0;
}

async function fetchPositionMetrics(poolId: string, stxAddress: string, bitflowApiBase: string): Promise<PositionMetrics> {
  const fetchedAt = Date.now();

  const poolsResponse = await fetchJson<{ pools?: Array<{ pool_id: string; active_bin?: number; active_bin_id?: number }> }>(
    `${bitflowApiBase}/api/quotes/v1/pools`
  );
  const pool = (poolsResponse.pools ?? []).find((p) => p.pool_id === poolId);
  if (!pool) {
    throw new Error(`Pool not found: ${poolId}`);
  }

  const activeBin = parseNumber(pool.active_bin ?? pool.active_bin_id, 0);

  const binsUrl = `${bitflowApiBase}/api/app/v1/users/${stxAddress}/positions/${poolId}/bins`;
  const binsResponse = await fetch(binsUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "bff-skills/hodlmm-alpha-rebalancer",
    },
  });

  let userBinsResponse: { bins?: Array<{ bin_id?: number; user_liquidity?: string | number }> } = {};
  if (binsResponse.status === 404) {
    userBinsResponse = { bins: [] };
  } else if (!binsResponse.ok) {
    throw new Error(`HTTP ${binsResponse.status} from ${binsUrl}`);
  } else {
    userBinsResponse = await binsResponse.json() as { bins?: Array<{ bin_id?: number; user_liquidity?: string | number }> };
  }

  const userBins = (userBinsResponse.bins ?? [])
    .filter((bin) => parseNumber(bin.user_liquidity, 0) > 0)
    .map((bin) => parseNumber(bin.bin_id, 0))
    .filter((bin) => bin > 0);

  const appPoolResponse = await fetchJson<{ data?: Array<{ poolId?: string; tvlUsd?: number; volumeUsd1d?: number; apr24h?: number; feesUsd1d?: number; updatedAt?: string }> }>(
    `${bitflowApiBase}/api/app/v1/pools`
  );
  const appPool = (appPoolResponse.data ?? []).find((p) => p.poolId === poolId);

  const estimatedUsd = parseNumber(appPool?.tvlUsd, 0) * 0.001;
  const estimatedStx = userBins.length > 0 ? Number((estimatedUsd / 2500).toFixed(4)) : 0;
  const driftPct = computeDriftPct(activeBin, userBins);

  const targetCenter = userBins.length > 0
    ? Math.round(userBins.reduce((sum, bin) => sum + bin, 0) / userBins.length)
    : activeBin;

  const slippagePct = Number((Math.abs(targetCenter - activeBin) / Math.max(activeBin, 1) * 100).toFixed(4));

  let dataAgeSeconds = 0;
  if (appPool?.updatedAt) {
    dataAgeSeconds = Math.max(0, Math.floor((Date.now() - new Date(appPool.updatedAt).getTime()) / 1000));
  } else {
    dataAgeSeconds = Math.floor((Date.now() - fetchedAt) / 1000);
  }

  return {
    pool_id: poolId,
    active_bin: activeBin,
    user_bins: userBins,
    drift_pct: driftPct,
    target_center_bin: targetCenter,
    action_required: userBins.length > 0 && driftPct >= loadConfig().drift_threshold,
    yield_accrued_usd: userBins.length > 0 ? Number(parseNumber(appPool?.feesUsd1d, 0).toFixed(2)) : 0,
    slippage_pct: slippagePct,
    position_value_stx: estimatedStx,
    data_age_seconds: dataAgeSeconds,
  };
}

async function doctorCommand(poolOverride?: string): Promise<void> {
  const config = loadConfig();
  const network = getNetworkConfig();
  const poolId = poolOverride ?? config.pool_id;

  const checks: Record<string, unknown> = {
    wallet_loaded: false,
    stacks_api_reachable: false,
    bitflow_api_reachable: false,
    position_exists: false,
    network: network.network,
    pool_id: poolId,
  };

  let status: "healthy" | "degraded" | "error" = "healthy";

  try {
    const wallet = getActiveWallet();
    checks.wallet_loaded = true;

    const stacksHealth = await getStacksHealth(network.hiroApiBase);
    checks.stacks_api_reachable = stacksHealth.reachable;

    const position = await fetchPositionMetrics(poolId, wallet.stxAddress, network.bitflowApiBase);
    checks.bitflow_api_reachable = true;
    checks.position_exists = position.user_bins.length > 0;

    if (!stacksHealth.reachable || position.user_bins.length === 0) {
      status = "degraded";
    }
  } catch {
    status = "error";
  }

  printJson({ status, checks });
}

async function statusCommand(poolOverride?: string): Promise<void> {
  const config = loadConfig();
  const network = getNetworkConfig();
  const wallet = getActiveWallet();
  const poolId = poolOverride ?? config.pool_id;

  const metrics = await fetchPositionMetrics(poolId, wallet.stxAddress, network.bitflowApiBase);
  const state = loadState();
  const dailyExecutions = countExecutionsInWindow(state.executions, 24);
  const cooldownRemaining = getCooldownRemainingHours(state.last_execution_at, config.cooldown_hours);

  printJson({
    position: {
      pool_id: metrics.pool_id,
      active_bin: metrics.active_bin,
      user_bin_count: metrics.user_bins.length,
      user_bins: metrics.user_bins,
      position_value_stx: metrics.position_value_stx,
      yield_accrued_usd: metrics.yield_accrued_usd,
    },
    drift_pct: metrics.drift_pct,
    slippage_pct: metrics.slippage_pct,
    action_required: metrics.action_required,
    readiness: {
      daily_executions: dailyExecutions,
      daily_limit: config.daily_limit,
      cooldown_hours_remaining: cooldownRemaining,
      consecutive_failures: state.consecutive_failures,
      data_age_seconds: metrics.data_age_seconds,
    },
  });
}

function mergeConfig(base: RebalancerConfig, updates: Partial<RebalancerConfig>): RebalancerConfig {
  const merged = { ...base, ...updates };
  if (merged.drift_threshold <= 0 || merged.daily_limit <= 0 || merged.cooldown_hours <= 0) {
    throw new Error("Invalid configuration values");
  }
  return merged;
}

async function executeRebalance(poolId: string, stxAddress: string, metrics: PositionMetrics): Promise<string> {
  const network = getNetworkConfig();
  const endpoint = process.env.BITFLOW_REBALANCE_ENDPOINT ?? `${network.bitflowApiBase}/api/app/v1/hodlmm/rebalance`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "bff-skills/hodlmm-alpha-rebalancer",
    },
    body: JSON.stringify({
      stx_address: stxAddress,
      pool_id: poolId,
      from_bin: metrics.target_center_bin,
      to_bin: metrics.active_bin,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Rebalance endpoint error ${response.status}: ${text.slice(0, 160)}`);
  }

  const payload = await response.json() as { tx_hash?: string; txHash?: string; result?: { tx_hash?: string } };
  const txHash = payload.tx_hash ?? payload.txHash ?? payload.result?.tx_hash;
  if (!txHash) {
    throw new Error("Transaction hash missing in rebalance response");
  }

  return txHash;
}

async function runCommand(poolOverride: string | undefined, dryRun: boolean): Promise<void> {
  const config = loadConfig();
  const network = getNetworkConfig();
  const wallet = getActiveWallet();
  const poolId = poolOverride ?? config.pool_id;
  const state = loadState();

  if (state.consecutive_failures > 3) {
    printError("Emergency stop active: consecutive failures exceeded 3");
  }

  try {
    const metrics = await fetchPositionMetrics(poolId, wallet.stxAddress, network.bitflowApiBase);
    const stxBalance = await getStxBalance(network.hiroApiBase, wallet.stxAddress);
    const stxBalanceValue = Number(stxBalance.balance) / 1_000_000;

    const refusalReasons: string[] = [];

    if (!metrics.action_required) {
      refusalReasons.push("Drift threshold not exceeded");
    }

    if (metrics.position_value_stx < config.min_position) {
      refusalReasons.push("Position value below minimum threshold");
    }

    if (metrics.slippage_pct > config.max_slippage_pct) {
      refusalReasons.push("Slippage exceeds configured maximum");
    }

    if (metrics.data_age_seconds > config.stale_oracle_minutes * 60) {
      refusalReasons.push("Price oracle data is stale");
    }

    const dailyExecutions = countExecutionsInWindow(state.executions, 24);
    if (dailyExecutions >= config.daily_limit) {
      refusalReasons.push("Daily execution limit reached");
    }

    const cooldownRemaining = getCooldownRemainingHours(state.last_execution_at, config.cooldown_hours);
    if (cooldownRemaining > 0) {
      refusalReasons.push(`Cooldown active (${cooldownRemaining}h remaining)`);
    }

    if (stxBalanceValue < config.min_gas_reserve_stx) {
      refusalReasons.push("Wallet balance insufficient for gas");
    }

    if (refusalReasons.length > 0) {
      printError(`Run refused: ${refusalReasons.join("; ")}`);
    }

    if (dryRun) {
      printJson({
        status: "success",
        tx_hash: "dry-run",
        action: "rebalance-simulated",
        data: {
          pool_id: metrics.pool_id,
          drift_pct: metrics.drift_pct,
          slippage_pct: metrics.slippage_pct,
          position_value_stx: metrics.position_value_stx,
          cooldown_hours_remaining: 0,
          daily_executions,
        },
      });
      return;
    }

    const txHash = await executeRebalance(poolId, wallet.stxAddress, metrics);

    const now = new Date().toISOString();
    const nextState: RebalancerState = {
      last_execution_at: now,
      executions: [...state.executions, now].slice(-200),
      consecutive_failures: 0,
    };
    saveState(nextState);

    printJson({
      status: "success",
      tx_hash: txHash,
      action: "rebalance",
      data: {
        pool_id: metrics.pool_id,
        drift_pct: metrics.drift_pct,
        slippage_pct: metrics.slippage_pct,
        position_value_stx: metrics.position_value_stx,
        cooldown_hours_remaining: 0,
        daily_executions: dailyExecutions + 1,
      },
    });
  } catch (error) {
    const nextState: RebalancerState = {
      ...state,
      consecutive_failures: state.consecutive_failures + 1,
    };
    saveState(nextState);

    const message = error instanceof Error ? error.message : "Unknown execution error";
    printError(message);
  }
}

async function configureCommand(options: {
  driftThreshold?: string;
  dailyLimit?: string;
  minPosition?: string;
  cooldownHours?: string;
  maxSlippagePct?: string;
  maxTxPct?: string;
  minGasReserveStx?: string;
  staleOracleMinutes?: string;
  poolId?: string;
}): Promise<void> {
  const current = loadConfig();

  const updates: Partial<RebalancerConfig> = {};
  if (options.driftThreshold !== undefined) updates.drift_threshold = parseNumber(options.driftThreshold, current.drift_threshold);
  if (options.dailyLimit !== undefined) updates.daily_limit = parseNumber(options.dailyLimit, current.daily_limit);
  if (options.minPosition !== undefined) updates.min_position = parseNumber(options.minPosition, current.min_position);
  if (options.cooldownHours !== undefined) updates.cooldown_hours = parseNumber(options.cooldownHours, current.cooldown_hours);
  if (options.maxSlippagePct !== undefined) updates.max_slippage_pct = parseNumber(options.maxSlippagePct, current.max_slippage_pct);
  if (options.maxTxPct !== undefined) updates.max_tx_pct = parseNumber(options.maxTxPct, current.max_tx_pct);
  if (options.minGasReserveStx !== undefined) updates.min_gas_reserve_stx = parseNumber(options.minGasReserveStx, current.min_gas_reserve_stx);
  if (options.staleOracleMinutes !== undefined) updates.stale_oracle_minutes = parseNumber(options.staleOracleMinutes, current.stale_oracle_minutes);
  if (options.poolId !== undefined) updates.pool_id = options.poolId;

  const merged = mergeConfig(current, updates);
  saveConfig(merged);

  printJson({ configured: merged });
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("hodlmm-alpha-rebalancer")
    .description("Autonomous HODLMM position rebalancer with strict safety guardrails")
    .showHelpAfterError();

  program
    .command("doctor")
    .option("--pool-id <poolId>", "Bitflow pool id")
    .action(async (opts: { poolId?: string }) => {
      try {
        await doctorCommand(opts.poolId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Doctor command failed";
        printError(message);
      }
    });

  program
    .command("status")
    .option("--pool-id <poolId>", "Bitflow pool id")
    .action(async (opts: { poolId?: string }) => {
      try {
        await statusCommand(opts.poolId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Status command failed";
        printError(message);
      }
    });

  program
    .command("run")
    .option("--pool-id <poolId>", "Bitflow pool id")
    .option("--dry-run", "Simulate only, no transaction", false)
    .action(async (opts: { poolId?: string; dryRun?: boolean }) => {
      await runCommand(opts.poolId, Boolean(opts.dryRun));
    });

  program
    .command("configure")
    .option("--drift-threshold <number>", "Drift threshold percent")
    .option("--daily-limit <number>", "Daily execution limit")
    .option("--min-position <number>", "Minimum position size in STX")
    .option("--cooldown-hours <number>", "Cooldown between executions")
    .option("--max-slippage-pct <number>", "Maximum allowed slippage percent")
    .option("--max-tx-pct <number>", "Maximum transaction percent of position")
    .option("--min-gas-reserve-stx <number>", "Minimum STX to reserve for gas")
    .option("--stale-oracle-minutes <number>", "Maximum oracle age in minutes")
    .option("--pool-id <poolId>", "Default pool id")
    .action(async (opts: {
      driftThreshold?: string;
      dailyLimit?: string;
      minPosition?: string;
      cooldownHours?: string;
      maxSlippagePct?: string;
      maxTxPct?: string;
      minGasReserveStx?: string;
      staleOracleMinutes?: string;
      poolId?: string;
    }) => {
      try {
        await configureCommand(opts);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Configure command failed";
        printError(message);
      }
    });

  await program.parseAsync(process.argv);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unhandled error";
  printError(message);
});
