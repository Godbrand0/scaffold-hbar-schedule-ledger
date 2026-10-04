/**
 * Placeholder written by the template so the app type-checks and builds before the first deploy.
 * `yarn foundry:deploy:testnet` regenerates this file with the real address. The zero address means
 * "not deployed yet" and the dashboard shows setup instructions instead of calling it.
 */
import { GenericContractsDeclaration } from "~~/utils/scaffold-hbar/contract";

const deployedContracts = {
  296: {
    RecurringPayments: {
      address: "0x0000000000000000000000000000000000000000",
      abi: [
        {
          type: "function",
          name: "CAPACITY_PROBES",
          inputs: [],
          outputs: [
            {
              name: "",
              type: "uint256",
              internalType: "uint256",
            },
          ],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "CAPACITY_UNAVAILABLE",
          inputs: [],
          outputs: [
            {
              name: "",
              type: "int64",
              internalType: "int64",
            },
          ],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "DUE_TOLERANCE_SECONDS",
          inputs: [],
          outputs: [
            {
              name: "",
              type: "uint256",
              internalType: "uint256",
            },
          ],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "MIN_INTERVAL_SECONDS",
          inputs: [],
          outputs: [
            {
              name: "",
              type: "uint32",
              internalType: "uint32",
            },
          ],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "MIN_LEAD_SECONDS",
          inputs: [],
          outputs: [
            {
              name: "",
              type: "uint256",
              internalType: "uint256",
            },
          ],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "PAYMENT_GAS_LIMIT",
          inputs: [],
          outputs: [
            {
              name: "",
              type: "uint256",
              internalType: "uint256",
            },
          ],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "RUN_GAS_LIMIT",
          inputs: [],
          outputs: [
            {
              name: "",
              type: "uint256",
              internalType: "uint256",
            },
          ],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "cancel",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              internalType: "uint256",
            },
          ],
          outputs: [],
          stateMutability: "nonpayable",
        },
        {
          type: "function",
          name: "createPlan",
          inputs: [
            {
              name: "recipient",
              type: "address",
              internalType: "address payable",
            },
            {
              name: "amountPerRun",
              type: "uint256",
              internalType: "uint256",
            },
            {
              name: "feeReservePerRun",
              type: "uint256",
              internalType: "uint256",
            },
            {
              name: "intervalSeconds",
              type: "uint32",
              internalType: "uint32",
            },
            {
              name: "runs",
              type: "uint32",
              internalType: "uint32",
            },
          ],
          outputs: [
            {
              name: "planId",
              type: "uint256",
              internalType: "uint256",
            },
          ],
          stateMutability: "payable",
        },
        {
          type: "function",
          name: "executeRun",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              internalType: "uint256",
            },
          ],
          outputs: [],
          stateMutability: "nonpayable",
        },
        {
          type: "function",
          name: "getPlan",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              internalType: "uint256",
            },
          ],
          outputs: [
            {
              name: "",
              type: "tuple",
              internalType: "struct RecurringPayments.Plan",
              components: [
                {
                  name: "owner",
                  type: "address",
                  internalType: "address",
                },
                {
                  name: "recipient",
                  type: "address",
                  internalType: "address payable",
                },
                {
                  name: "amountPerRun",
                  type: "uint256",
                  internalType: "uint256",
                },
                {
                  name: "feeReservePerRun",
                  type: "uint256",
                  internalType: "uint256",
                },
                {
                  name: "intervalSeconds",
                  type: "uint32",
                  internalType: "uint32",
                },
                {
                  name: "totalRuns",
                  type: "uint32",
                  internalType: "uint32",
                },
                {
                  name: "completedRuns",
                  type: "uint32",
                  internalType: "uint32",
                },
                {
                  name: "nextRunAt",
                  type: "uint64",
                  internalType: "uint64",
                },
                {
                  name: "scheduleAddress",
                  type: "address",
                  internalType: "address",
                },
                {
                  name: "status",
                  type: "uint8",
                  internalType: "enum RecurringPayments.Status",
                },
              ],
            },
          ],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "planCount",
          inputs: [],
          outputs: [
            {
              name: "",
              type: "uint256",
              internalType: "uint256",
            },
          ],
          stateMutability: "view",
        },
        {
          type: "function",
          name: "rebook",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              internalType: "uint256",
            },
          ],
          outputs: [],
          stateMutability: "nonpayable",
        },
        {
          type: "function",
          name: "resume",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              internalType: "uint256",
            },
          ],
          outputs: [],
          stateMutability: "nonpayable",
        },
        {
          type: "event",
          name: "PaymentExecuted",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              indexed: true,
              internalType: "uint256",
            },
            {
              name: "runIndex",
              type: "uint32",
              indexed: false,
              internalType: "uint32",
            },
            {
              name: "recipient",
              type: "address",
              indexed: true,
              internalType: "address",
            },
            {
              name: "amount",
              type: "uint256",
              indexed: false,
              internalType: "uint256",
            },
          ],
          anonymous: false,
        },
        {
          type: "event",
          name: "PaymentFailed",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              indexed: true,
              internalType: "uint256",
            },
            {
              name: "runIndex",
              type: "uint32",
              indexed: false,
              internalType: "uint32",
            },
            {
              name: "recipient",
              type: "address",
              indexed: true,
              internalType: "address",
            },
            {
              name: "amount",
              type: "uint256",
              indexed: false,
              internalType: "uint256",
            },
          ],
          anonymous: false,
        },
        {
          type: "event",
          name: "PlanCancelled",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              indexed: true,
              internalType: "uint256",
            },
            {
              name: "refunded",
              type: "uint256",
              indexed: false,
              internalType: "uint256",
            },
          ],
          anonymous: false,
        },
        {
          type: "event",
          name: "PlanCompleted",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              indexed: true,
              internalType: "uint256",
            },
          ],
          anonymous: false,
        },
        {
          type: "event",
          name: "PlanCreated",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              indexed: true,
              internalType: "uint256",
            },
            {
              name: "owner",
              type: "address",
              indexed: true,
              internalType: "address",
            },
            {
              name: "recipient",
              type: "address",
              indexed: true,
              internalType: "address",
            },
            {
              name: "amountPerRun",
              type: "uint256",
              indexed: false,
              internalType: "uint256",
            },
            {
              name: "feeReservePerRun",
              type: "uint256",
              indexed: false,
              internalType: "uint256",
            },
            {
              name: "intervalSeconds",
              type: "uint32",
              indexed: false,
              internalType: "uint32",
            },
            {
              name: "totalRuns",
              type: "uint32",
              indexed: false,
              internalType: "uint32",
            },
          ],
          anonymous: false,
        },
        {
          type: "event",
          name: "PlanResumed",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              indexed: true,
              internalType: "uint256",
            },
          ],
          anonymous: false,
        },
        {
          type: "event",
          name: "ScheduleBooked",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              indexed: true,
              internalType: "uint256",
            },
            {
              name: "runIndex",
              type: "uint32",
              indexed: false,
              internalType: "uint32",
            },
            {
              name: "scheduleAddress",
              type: "address",
              indexed: false,
              internalType: "address",
            },
            {
              name: "expirySecond",
              type: "uint256",
              indexed: false,
              internalType: "uint256",
            },
          ],
          anonymous: false,
        },
        {
          type: "event",
          name: "ScheduleFailed",
          inputs: [
            {
              name: "planId",
              type: "uint256",
              indexed: true,
              internalType: "uint256",
            },
            {
              name: "runIndex",
              type: "uint32",
              indexed: false,
              internalType: "uint32",
            },
            {
              name: "responseCode",
              type: "int64",
              indexed: false,
              internalType: "int64",
            },
            {
              name: "expirySecond",
              type: "uint256",
              indexed: false,
              internalType: "uint256",
            },
          ],
          anonymous: false,
        },
        {
          type: "error",
          name: "InvalidAmount",
          inputs: [],
        },
        {
          type: "error",
          name: "InvalidInterval",
          inputs: [],
        },
        {
          type: "error",
          name: "InvalidRecipient",
          inputs: [],
        },
        {
          type: "error",
          name: "InvalidRuns",
          inputs: [],
        },
        {
          type: "error",
          name: "NotDue",
          inputs: [
            {
              name: "nextRunAt",
              type: "uint64",
              internalType: "uint64",
            },
          ],
        },
        {
          type: "error",
          name: "NotOwner",
          inputs: [],
        },
        {
          type: "error",
          name: "ReentrancyGuardReentrantCall",
          inputs: [],
        },
        {
          type: "error",
          name: "RefundFailed",
          inputs: [],
        },
        {
          type: "error",
          name: "UnknownPlan",
          inputs: [],
        },
        {
          type: "error",
          name: "WrongEscrow",
          inputs: [
            {
              name: "expected",
              type: "uint256",
              internalType: "uint256",
            },
            {
              name: "provided",
              type: "uint256",
              internalType: "uint256",
            },
          ],
        },
        {
          type: "error",
          name: "WrongStatus",
          inputs: [
            {
              name: "current",
              type: "uint8",
              internalType: "enum RecurringPayments.Status",
            },
          ],
        },
      ],
      inheritedFunctions: {},
      deployedOnBlock: 0,
    },
  },
} as const;

export default deployedContracts satisfies GenericContractsDeclaration;
