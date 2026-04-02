import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface ActiveWallet {
  btcAddress: string;
  stxAddress: string;
}

function isBitcoinAddress(value: string): boolean {
  return /^(bc1|[13])[a-zA-Z0-9]{20,}$/.test(value);
}

function isStacksAddress(value: string): boolean {
  return /^SP[0-9A-Z]{20,}$/.test(value.toUpperCase());
}

export function getActiveWallet(): ActiveWallet {
  const envBtc = process.env.AIBTC_BTC_ADDRESS?.trim() ?? "";
  const envStx = process.env.AIBTC_STX_ADDRESS?.trim() ?? "";

  if (isBitcoinAddress(envBtc) && isStacksAddress(envStx)) {
    return { btcAddress: envBtc, stxAddress: envStx };
  }

  const walletFile = join(homedir(), ".aibtc", "wallets.json");
  if (!existsSync(walletFile)) {
    throw new Error("AIBTC wallet file not found. Run: npx @aibtc/mcp-server@latest --install");
  }

  const parsed = JSON.parse(readFileSync(walletFile, "utf8")) as Record<string, unknown>;
  const btcAddress = String(parsed.btcAddress ?? "").trim();
  const stxAddress = String(parsed.stxAddress ?? "").trim().toUpperCase();

  if (!isBitcoinAddress(btcAddress) || !isStacksAddress(stxAddress)) {
    throw new Error("Invalid wallet addresses in ~/.aibtc/wallets.json");
  }

  return { btcAddress, stxAddress };
}
