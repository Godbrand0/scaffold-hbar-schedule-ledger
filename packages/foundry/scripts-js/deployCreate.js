// Deploys to Hedera networks with `forge create` instead of `forge script`.
//
// `forge script` forks the target chain and asks the RPC for state at a block given as an EIP-1898 object.
// Hashio rejects that ("Invalid parameter 1 ... Expected 0x prefixed hexadecimal block number"), so script-based
// deploys fail before sending anything. `forge create` sends a plain transaction and works.
//
// After deploying it writes deployments/<chainId>.json and regenerates the frontend's deployedContracts.ts.
// Called by parseArgs.js with RPC_URL (network name from foundry.toml) and ETH_KEYSTORE_ACCOUNT set.
// Set ETH_PASSWORD_FILE to skip the keystore password prompt.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "toml";
import { format } from "prettier";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const network = process.env.RPC_URL;
const account = process.env.ETH_KEYSTORE_ACCOUNT;

const CHAIN_IDS = { hedera_testnet: 296, hedera_mainnet: 295 };
// Supra's price storage contract on each network. HBAR/USD is pair 432. USD plans reject a price older than
// MAX_PRICE_AGE_SECONDS. Override with SUPRA_STORAGE, SUPRA_HBAR_USD_PAIR and MAX_PRICE_AGE_SECONDS.
const SUPRA_STORAGE = {
  hedera_testnet: "0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917",
  hedera_mainnet: "0xD02cc7a670047b6b012556A88e275c685d25e0c9",
};
const priceFeedArgs = [
  process.env.SUPRA_STORAGE ?? SUPRA_STORAGE[network],
  process.env.SUPRA_HBAR_USD_PAIR ?? "432",
  process.env.MAX_PRICE_AGE_SECONDS ?? "3600",
];

const CONTRACTS = [
  {
    name: "RecurringPayments",
    source: "contracts/RecurringPayments.sol",
    gasLimit: "3500000",
    constructorArgs: priceFeedArgs,
  },
];

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
  });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${command} ${args[0]} failed (exit ${result.status}).`);
  return result.stdout ?? "";
}

const chainId = CHAIN_IDS[network];
if (!chainId)
  fail(
    `deployCreate.js supports ${Object.keys(CHAIN_IDS).join(
      ", "
    )}, got '${network}'.`
  );
if (!account) fail("ETH_KEYSTORE_ACCOUNT is not set.");

const rpcUrl = parse(readFileSync(join(root, "foundry.toml"), "utf8"))
  .rpc_endpoints?.[network];
if (!rpcUrl) fail(`No rpc_endpoints entry for '${network}' in foundry.toml.`);

run("forge", ["build"]);

const deployed = [];
for (const contract of CONTRACTS) {
  console.log(`\n🚀 Deploying ${contract.name} to ${network}...`);
  const args = [
    "create",
    `${contract.source}:${contract.name}`,
    "--rpc-url",
    rpcUrl,
    "--account",
    account,
    "--legacy",
    "--broadcast",
    "--gas-limit",
    contract.gasLimit,
  ];
  if (process.env.ETH_PASSWORD_FILE)
    args.push("--password-file", process.env.ETH_PASSWORD_FILE);
  // Last on purpose: --constructor-args takes every value up to the next flag, and keeping it at the end avoids it
  // swallowing anything else.
  if (contract.constructorArgs?.length)
    args.push("--constructor-args", ...contract.constructorArgs);

  const output = run("forge", args, { capture: true });
  process.stdout.write(output);
  const address = /Deployed to:\s*(0x[0-9a-fA-F]{40})/.exec(output)?.[1];
  const hash = /Transaction hash:\s*(0x[0-9a-fA-F]{64})/.exec(output)?.[1];
  if (!address)
    fail(
      `Could not find the deployed address in forge output for ${contract.name}.`
    );
  deployed.push({ ...contract, address, hash });
}

async function blockOf(hash) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const out = spawnSync(
      "cast",
      ["receipt", hash, "blockNumber", "--rpc-url", rpcUrl],
      { encoding: "utf8" }
    );
    const block = Number.parseInt(out.stdout?.trim(), 10);
    if (out.status === 0 && Number.isInteger(block)) return block;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return undefined;
}

// deployments/<chainId>.json, same shape the Solidity deploy scripts export: { address: name, networkName }.
const deploymentsDir = join(root, "deployments");
if (!existsSync(deploymentsDir)) mkdirSync(deploymentsDir, { recursive: true });
const exported = Object.fromEntries(deployed.map((d) => [d.address, d.name]));
exported.networkName = network;
writeFileSync(
  join(deploymentsDir, `${chainId}.json`),
  JSON.stringify(exported, null, 2)
);

// Frontend contract file.
const chainConfig = {};
for (const d of deployed) {
  const artifact = JSON.parse(
    readFileSync(join(root, "out", `${d.name}.sol`, `${d.name}.json`), "utf8")
  );
  chainConfig[d.name] = {
    address: d.address,
    abi: artifact.abi,
    inheritedFunctions: {},
    deployedOnBlock: await blockOf(d.hash),
  };
}
const target = join(root, "..", "nextjs", "contracts", "deployedContracts.ts");
const content = `/**
 * This file is autogenerated by Scaffold-HBAR (scripts-js/deployCreate.js).
 * You should not edit it manually or your changes might be overwritten.
 */
import { GenericContractsDeclaration } from "~~/utils/scaffold-hbar/contract";

const deployedContracts = {${chainId}: ${JSON.stringify(
  chainConfig,
  null,
  2
)}} as const;

export default deployedContracts satisfies GenericContractsDeclaration;
`;
writeFileSync(target, await format(content, { parser: "typescript" }));

console.log(
  `\n✅ Deployed. Addresses saved to deployments/${chainId}.json and ${target}`
);
for (const d of deployed) {
  console.log(`   ${d.name}: ${d.address}  (tx ${d.hash})`);
}
