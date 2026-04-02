export type SupportedNetwork = "mainnet";

export interface NetworkConfig {
  network: SupportedNetwork;
  bitflowApiBase: string;
  hiroApiBase: string;
}

export function getNetworkConfig(): NetworkConfig {
  return {
    network: "mainnet",
    bitflowApiBase: process.env.BITFLOW_API_BASE ?? "https://bff.bitflowapis.finance",
    hiroApiBase: process.env.HIRO_API_BASE ?? "https://api.mainnet.hiro.so",
  };
}
