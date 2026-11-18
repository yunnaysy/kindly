// Network + token config shared by the web app, the agent and the scripts.
import { defineChain } from "viem";

export const aevumTestnet = defineChain({
  id: 44005,
  name: "QDay Aevum Testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-test.qday.info"], webSocket: ["wss://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: "https://explorer-test.qday.info" } },
  testnet: true,
});

export const localAnvil = defineChain({
  id: 31337,
  name: "Local Anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  testnet: true,
});

/** Official tUSD8 test stablecoin on Aevum (ERC-20, 6 decimals). */
export const TUSD8_AEVUM = "0x456569838f1d43009A91ebA4263147Afd7233483";
export const TOKEN_DECIMALS = 6;
export const FAUCET_URL = "https://faucet.qday.info/en";

export function chainById(id) {
  if (Number(id) === aevumTestnet.id) return aevumTestnet;
  if (Number(id) === localAnvil.id) return localAnvil;
  throw new Error(`Unsupported chain ${id}. Kindly only runs on Aevum Testnet (44005) or local anvil.`);
}

export function explorerTx(chainId, hash) {
  return Number(chainId) === aevumTestnet.id ? `${aevumTestnet.blockExplorers.default.url}/tx/${hash}` : null;
}
export function explorerAddress(chainId, addr) {
  return Number(chainId) === aevumTestnet.id ? `${aevumTestnet.blockExplorers.default.url}/address/${addr}` : null;
}
