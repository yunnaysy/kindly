// Loads keys for scripts. Secrets live in git-ignored files with mode 600 and are never printed.
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const root = new URL("..", import.meta.url).pathname;

// Well-known anvil dev keys (public, local chain only).
const ANVIL = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];

function readDeployerKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY;
  const f = `${root}DEPLOYER_SECRET.txt`;
  if (!existsSync(f)) throw new Error("No PRIVATE_KEY env and no DEPLOYER_SECRET.txt");
  const m = /PRIVATE_KEY=(0x[0-9a-fA-F]{64})/.exec(readFileSync(f, "utf8"));
  if (!m) throw new Error("DEPLOYER_SECRET.txt has no PRIVATE_KEY line");
  return m[1];
}

function readOrCreateDemoKeys() {
  const f = `${root}DEMO_KEYS_SECRET.json`;
  if (!existsSync(f)) {
    writeFileSync(f, JSON.stringify({ merchant: generatePrivateKey(), agent: generatePrivateKey() }, null, 2), { mode: 0o600 });
  }
  chmodSync(f, 0o600);
  return JSON.parse(readFileSync(f, "utf8"));
}

/** operator = deployer + attester + the paying business; merchant = invoice issuer; agent = AP bot hot key. */
export function loadAccounts(chainId) {
  if (Number(chainId) === 31337) {
    return { operator: privateKeyToAccount(ANVIL[0]), merchant: privateKeyToAccount(ANVIL[1]), agent: privateKeyToAccount(ANVIL[2]) };
  }
  const demo = readOrCreateDemoKeys();
  return {
    operator: privateKeyToAccount(readDeployerKey()),
    merchant: privateKeyToAccount(process.env.MERCHANT_KEY || demo.merchant),
    agent: privateKeyToAccount(process.env.AGENT_KEY || demo.agent),
  };
}
