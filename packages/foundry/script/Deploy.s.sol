//SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { RecurringPayments } from "../contracts/RecurringPayments.sol";
import { ISupraSValueFeed } from "../contracts/interfaces/ISupraSValueFeed.sol";

/**
 * @notice Deploys RecurringPayments, the contract whose events the Rust indexer follows.
 * @dev Run with `yarn foundry:deploy:testnet`. Real HSS scheduling only works on Hedera testnet or mainnet.
 */
contract DeployScript is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        // Supra price storage on Hedera: testnet (296) and mainnet (295). HBAR_USD is pair 432.
        address feed = block.chainid == 295
            ? 0xD02cc7a670047b6b012556A88e275c685d25e0c9
            : 0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917;
        RecurringPayments payments = new RecurringPayments(ISupraSValueFeed(feed), 432, 7200);
        deployments.push(Deployment({ name: "RecurringPayments", addr: address(payments) }));
    }
}
