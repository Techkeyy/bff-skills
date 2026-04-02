export interface StxBalance {
  balance: bigint;
}

export interface StacksHealth {
  reachable: boolean;
  chainTip: string | null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "bff-skills/hodlmm-alpha-rebalancer",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  return response.json() as Promise<T>;
}

export async function getStacksHealth(hiroApiBase: string): Promise<StacksHealth> {
  try {
    const data = await fetchJson<{ stacks_tip_height?: number }>(`${hiroApiBase}/v2/info`);
    const height = typeof data.stacks_tip_height === "number" ? String(data.stacks_tip_height) : null;
    return { reachable: true, chainTip: height };
  } catch {
    return { reachable: false, chainTip: null };
  }
}

export async function getStxBalance(hiroApiBase: string, stxAddress: string): Promise<StxBalance> {
  const data = await fetchJson<{ balance?: string }>(`${hiroApiBase}/extended/v1/address/${stxAddress}/balances`);
  const raw = data.balance ?? "0";
  return { balance: BigInt(raw) };
}
