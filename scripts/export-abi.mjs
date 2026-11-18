// Copies ABIs + bytecode from Foundry artifacts into shared/abi so the web app, agent and scripts share one source.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
mkdirSync(`${root}shared/abi`, { recursive: true });
for (const name of ["PayeeRegistry", "Kindly", "MockUSD8"]) {
  const art = JSON.parse(readFileSync(`${root}contracts/out/${name}.sol/${name}.json`, "utf8"));
  writeFileSync(`${root}shared/abi/${name}.json`, JSON.stringify({ abi: art.abi, bytecode: art.bytecode.object }, null, 0));
  console.log(`exported ${name}`);
}
