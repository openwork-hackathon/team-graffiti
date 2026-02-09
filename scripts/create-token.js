#!/usr/bin/env node

/**
 * Create $GRAFFITI token on Mint Club V2 (Base)
 *
 * Usage:
 *   PRIVATE_KEY=0x... node scripts/create-token.js
 *
 * Requires:
 *   - Private key for a wallet with ETH on Base (for gas + creation fee)
 *   - That wallet must hold $OPENWORK tokens (for bonding curve reserve approval)
 */

import { ethers } from "ethers";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: Set PRIVATE_KEY env var");
  console.error("Usage: PRIVATE_KEY=0x... node scripts/create-token.js");
  process.exit(1);
}

// Base mainnet
const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
const signer = new ethers.Wallet(PRIVATE_KEY, provider);

// Contracts
const BOND_ADDRESS = "0xc5a076cad94176c2996B32d8466Be1cE757FAa27";
const OPENWORK_TOKEN = "0x299c30DD5974BF4D5bFE42C340CA40462816AB07";

const BOND_ABI = [
  "function createToken((string name, string symbol) tokenParams, (uint16 mintRoyalty, uint16 burnRoyalty, address reserveToken, uint128 maxSupply, uint128[] stepRanges, uint128[] stepPrices) bondParams) external payable returns (address)",
  "function creationFee() view returns (uint256)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

async function main() {
  const address = await signer.getAddress();
  console.log("Wallet:", address);

  const ethBalance = await provider.getBalance(address);
  console.log("ETH balance:", ethers.formatEther(ethBalance), "ETH");

  const openwork = new ethers.Contract(OPENWORK_TOKEN, ERC20_ABI, signer);
  const owBalance = await openwork.balanceOf(address);
  console.log("$OPENWORK balance:", ethers.formatEther(owBalance));

  if (ethBalance === 0n) {
    console.error("\nNo ETH on Base. Fund this wallet first.");
    process.exit(1);
  }

  const bond = new ethers.Contract(BOND_ADDRESS, BOND_ABI, signer);
  const fee = await bond.creationFee();
  console.log("Creation fee:", ethers.formatEther(fee), "ETH");

  if (ethBalance < fee) {
    console.error(`\nNot enough ETH. Need at least ${ethers.formatEther(fee)} ETH.`);
    process.exit(1);
  }

  const tokenParams = {
    name: "Graffiti Token",
    symbol: "GRAFFITI",
  };

  const bondParams = {
    mintRoyalty: 100, // 1%
    burnRoyalty: 100, // 1%
    reserveToken: OPENWORK_TOKEN,
    maxSupply: ethers.parseEther("1000000"),
    stepRanges: [
      ethers.parseEther("100000"),
      ethers.parseEther("500000"),
      ethers.parseEther("1000000"),
    ],
    stepPrices: [
      ethers.parseEther("0.001"),
      ethers.parseEther("0.005"),
      ethers.parseEther("0.01"),
    ],
  };

  console.log("\n--- Creating $GRAFFITI ---");
  console.log("Name:", tokenParams.name);
  console.log("Symbol:", tokenParams.symbol);
  console.log("Max Supply: 1,000,000");
  console.log("Bonding Curve: 3-step (0.001 -> 0.005 -> 0.01 $OPENWORK)");
  console.log("Royalties: 1% mint, 1% burn");

  // Approve $OPENWORK spend
  console.log("\nApproving $OPENWORK spend...");
  const allowance = await openwork.allowance(address, BOND_ADDRESS);
  if (allowance < ethers.parseEther("1000000")) {
    const approveTx = await openwork.approve(BOND_ADDRESS, ethers.MaxUint256);
    console.log("Approve TX:", approveTx.hash);
    await approveTx.wait();
    console.log("Approved!");
  } else {
    console.log("Already approved.");
  }

  // Create token
  console.log("\nCreating token...");
  const tx = await bond.createToken(tokenParams, bondParams, { value: fee });
  console.log("TX:", tx.hash);
  console.log("Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log("Confirmed in block:", receipt.blockNumber);
  console.log("\n=== $GRAFFITI Created! ===");
  console.log("TX Hash:", receipt.hash);
  console.log("View: https://mint.club/token/base/GRAFFITI");
  console.log("BaseScan: https://basescan.org/tx/" + receipt.hash);
  console.log("\nNext steps:");
  console.log("1. Set GRAFFITI_TOKEN_ADDRESS env var in Vercel");
  console.log("2. Register token with hackathon API:");
  console.log("   PATCH /api/hackathon/049af368-62d8-4a9a-9147-f8cf2d829b21");
  console.log('   {"token_url": "https://mint.club/token/base/GRAFFITI"}');
}

main().catch((e) => {
  console.error("Error:", e.message || e);
  if (e.data) console.error("Data:", e.data);
  process.exit(1);
});
