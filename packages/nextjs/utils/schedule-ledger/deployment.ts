// The reference deployment made while building this template, and the transactions that prove it works.
// Everything here is public testnet data and can be checked on Hashscan.
export const HASHSCAN = "https://hashscan.io/testnet";

export const LIVE_CONTRACT = {
  id: "0.0.10861866",
  evmAddress: "0xFD70C4780318495fa11Ac6337c8125F041f6f302",
  network: "Hedera testnet (chain 296)",
};

export type ProofRow = {
  scenario: string;
  outcome: string;
  links: { label: string; kind: "transaction" | "schedule"; id: string }[];
};

export const PROOF: ProofRow[] = [
  {
    scenario: "Chained runs with no keeper (2 runs, 60 s apart)",
    outcome:
      "Run 1 fired through the Schedule Service, paid the recipient and booked run 2 itself. Run 2 fired, paid and completed the plan.",
    links: [
      {
        label: "create",
        kind: "transaction",
        id: "0xc8410ea22c818f0cd47fc5a05b086942e52f4d778c480181fa8ad8c6d82a6ea1",
      },
      { label: "run 1", kind: "transaction", id: "0x8f162b6701b64e5fce5d3d173f5c5cba765d31216f518ca4b5c74204d6eebecc" },
      { label: "run 2", kind: "transaction", id: "0x586d5c964df8aba49a2f59d991343d13ca854d37e99c9e4af54b1836d3342d61" },
      { label: "schedule 1", kind: "schedule", id: "0.0.10861887" },
      { label: "schedule 2", kind: "schedule", id: "0.0.10861895" },
    ],
  },
  {
    scenario: "Failure and recovery (recipient rejects funds)",
    outcome:
      "The run emitted PaymentFailed and paused the plan instead of reverting. After the recipient accepted funds, resume re-booked it and the plan completed.",
    links: [
      {
        label: "create",
        kind: "transaction",
        id: "0x730f01a469d7640fb3bde5ccb9177772672da13e2b415befd624122339b06245",
      },
      {
        label: "failed run",
        kind: "transaction",
        id: "0x35cab11a53b2064770e322c4ecf2ed4c52b2679843994743e2d07cf95f79fd21",
      },
      {
        label: "resume",
        kind: "transaction",
        id: "0xf3e11e3f57288ea716d7f2435856d577e26ad310b75c0d83ed9e2c9308cd8cd2",
      },
      {
        label: "paid run",
        kind: "transaction",
        id: "0xde10243bb68a926299c1d0c8bb2ebbb93bba43f979ce2adbad09f04a1bf376e8",
      },
    ],
  },
  {
    scenario: "Cancel with refund",
    outcome: "cancel deleted the pending schedule and refunded the full 3.6 HBAR escrow.",
    links: [
      {
        label: "create",
        kind: "transaction",
        id: "0x24108aabbcf2f6a8f80c8207c933de03dcf950538281e33b6445b674fa2dbee3",
      },
      {
        label: "cancel",
        kind: "transaction",
        id: "0xcd3fcb79f46e8eae4c31cb2aa7a11984375e23309fac4d01de133e1469845ca6",
      },
      { label: "schedule", kind: "schedule", id: "0.0.10861936" },
    ],
  },
];

export const hashscanUrl = (kind: "transaction" | "schedule" | "contract", id: string) => `${HASHSCAN}/${kind}/${id}`;
