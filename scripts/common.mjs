import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { chainById, TUSD8_AEVUM, FAUCET_URL } from "../shared/config.js";
import { loadAccounts } from "./keys.mjs";

export const root = new URL("..", import.meta.url).pathname;
export const artifact = (n) => JSON.parse(readFileSync(`${root}shared/abi/${n}.json`, "utf8"));
export const DEPLOYMENTS = `${root}deployments/deployments.json`;

export async function setup() {
  const chainId = Number(process.env.CHAIN_ID || 44005);
  const chain = chainById(chainId); // throws on anything except Aevum testnet / local anvil (mainnet guard)
  const rpc = process.env.RPC_URL || chain.rpcUrls.default.http[0];
  const transport = http(rpc, { retryCount: 3, timeout: 60_000 });
  const pub = createPublicClient({ chain, transport });
  const live = await pub.getChainId();
  if (live !== chainId) throw new Error(`RPC reports chain ${live}, expected ${chainId}. Refusing to continue.`);
  const accounts = loadAccounts(chainId);
  const wallet = (account) => createWalletClient({ chain, transport, account });
  return { chainId, chain, pub, accounts, wallet, TUSD8: TUSD8_AEVUM, FAUCET_URL };
}

export function readDeployments() {
  return existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : {};
}
export function writeDeployment(chainId, data) {
  const all = readDeployments();
  all[chainId] = data;
  writeFileSync(DEPLOYMENTS, JSON.stringify(all, null, 2) + "\n");
  // Web app reads the same file at build time.
  writeFileSync(`${root}web/src/deployments.json`, JSON.stringify(all, null, 2) + "\n");
}
