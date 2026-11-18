// Deploys PayeeRegistry + Kindly. On Aevum it binds to the official tUSD8; on anvil it deploys MockUSD8.
import { formatEther } from "viem";
import { setup, artifact, writeDeployment } from "./common.mjs";
import { explorerTx, explorerAddress } from "../shared/config.js";

export async function deploy() {
  const { chainId, pub, accounts, wallet, TUSD8, FAUCET_URL } = await setup();
  const op = accounts.operator;
  const bal = await pub.getBalance({ address: op.address });
  console.log(`chain ${chainId} deployer ${op.address} balance ${formatEther(bal)}`);
  if (bal === 0n) {
    console.log(`Deployer has no gas. Fund it at ${FAUCET_URL} (paste ${op.address}) and re-run.`);
    process.exit(2);
  }
  const w = wallet(op);
  const send = async (label, a, args) => {
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} deploy failed ${hash}`);
    console.log(`${label} ${r.contractAddress} tx ${hash} ${explorerTx(chainId, hash) ?? ""}`);
    return { address: r.contractAddress, tx: hash, block: Number(r.blockNumber) };
  };
  let token = TUSD8;
  let mock;
  if (chainId === 31337) {
    mock = await send("MockUSD8", artifact("MockUSD8"), []);
    token = mock.address;
  }
  const reg = await send("PayeeRegistry", artifact("PayeeRegistry"), [op.address]);
  const kindly = await send("Kindly", artifact("Kindly"), [token, reg.address, op.address]);
  const out = {
    chainId,
    token,
    registry: reg.address,
    kindly: kindly.address,
    operator: op.address,
    deployBlock: reg.block,
    txs: { registry: reg.tx, kindly: kindly.tx, ...(mock ? { mockToken: mock.tx } : {}) },
    explorer: { registry: explorerAddress(chainId, reg.address), kindly: explorerAddress(chainId, kindly.address) },
    deployedAt: new Date().toISOString(),
  };
  writeDeployment(chainId, out);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) deploy().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
