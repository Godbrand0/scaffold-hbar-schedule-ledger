//SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { RecurringPayments } from "../contracts/RecurringPayments.sol";

/**
 * @notice Deploys RecurringPayments, the contract whose events the Rust indexer follows.
 * @dev Run with `yarn foundry:deploy:testnet`. Real HSS scheduling only works on Hedera testnet or mainnet.
 */
contract DeployScript is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        RecurringPayments payments = new RecurringPayments();
        deployments.push(Deployment({ name: "RecurringPayments", addr: address(payments) }));
    }
}
