# Foundry package

Solidity contracts, Forge scripts and tests for the Hedera EVM.

| Path                            | Purpose                                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| `contracts/RecurringPayments.sol` | Escrowed recurring payments booked through the Schedule Service      |
| `contracts/interfaces/`         | `IHederaScheduleService` (HSS system contract at `0x16b`)            |
| `test/RecurringPayments.t.sol`  | Unit and fuzz tests                                                  |
| `test/mocks/`                   | Mock HSS and a recipient that rejects funds                          |
| `script/Deploy.s.sol`           | Deploys `RecurringPayments` and exports `deployments/<chainId>.json` |

## Setup

Forge dependencies (`forge-std`, OpenZeppelin) are git submodules under `lib/`. If you cloned this repository
directly instead of scaffolding it, fetch them from the repo root:

```bash
git submodule update --init --recursive
```

`create-scaffold-hbar` runs `forge install` for you.

## Tests

```bash
yarn test        # forge test
```

The Schedule Service is not available on Anvil or Hedera forks, so the tests etch `MockHederaScheduleService`
at `0x16b` and fire scheduled calls by hand. This makes them fast and offline, but they cannot prove how the real
network behaves. Check that against testnet (see the root README).

The mock stores nothing at construction time because `vm.etch` copies bytecode only. Every default in the mock
must be the zero value.

## Deploy

```bash
yarn foundry:account:generate      # creates a keystore; fund its address at https://portal.hedera.com/faucet
yarn foundry:deploy:testnet
```

The deployer must be a funded Hedera account, otherwise Hashio answers
`Requested resource not found. address '0x...'`. The Makefile deploys with `--slow --legacy` so each transaction
confirms before the next one (avoids `WRONG_NONCE`).

After deploying, `deployments/296.json` holds the address and `packages/nextjs/contracts/deployedContracts.ts` is
regenerated for the frontend.
