# GMX Arbitrage Smart Contract
**Author:** Erik Lochashvili  
**Network:** Arbitrum One  
## Overview
This smart contract enables flash loan-based 
arbitrage between GMX and other DEXs (like 
Uniswap). The contract executes triangular 
arbitrage opportunities without requiring initial 
capital.

## Key Features
- Flash loan integration with Aave V3
- GMX and Uniswap/Sushiswap router interfaces
- Customizable slippage tolerance
- Profit calculation and automatic loan repayment
- Owner-restricted access control

## Contract Addresses (Arbitrum Mainnet)
| Contract | Address |
|----------|---------|
| Aave Pool | `0x794a61358D6845
594F94dc1DB02A252b5b4814aD` 
|
| GMX Router | `0xaBBc5F99639c9
B6bCb58544ddf04EFA6802F4064` 
|
| Uniswap Router | `0x1b02dA8Cb0d0
97eB8D57A175b88c7D8b47997506` 
|

## Usage
### 1. Deploy Contract
```javascript
// Arbitrum mainnet addresses
const aavePool = "0x794a61358D6845594F94d
c1DB02A252b5b4814aD";
const gmxRouter = "0xaBBc5F99639c9B6bCb58
544ddf04EFA6802F4064";
const uniswapRouter = "0x1b02dA8Cb0d097eB
8D57A175b88c7D8b47997506";

// Deploy
const GMXArbitrageur = await 
ethers.getContractFactory("GMXArbitrageur");
const contract = await GMXArbitrageur.deploy(aavePool, gmxRouter, uniswapRouter);
```

### 2. Execute Arbitrage
```javascript
// Example: 1000 USDC arbitrage
await contract.startArbitrage(
    "0xFF970A61A04b1cA14834
    A43f5dE4533eBDDB5CC8", 
    // USDC  1000000000, 
    // 1000 USDC (6 decimals) 
    "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", 
    // WETH  497500000000000000, 
    // 0.4975 WETH min out (GMX)  1005000000 
    // 1005 USDC min out (Uniswap));
```

### 3. Configuration
```javascript
// Set slippage tolerance (50 = 0.5%)
await contract.setSlippageTolerance(50);
// Withdraw tokens from contract
await contract.rescueTokens(tokenAddress);
```

## Workflow
1. Manually detect price discrepancy between 
GMX and Uniswap
2. Calculate expected profit after fees (flash loan 
premium: 0.09%)
3. Call `startArbitrage()` with appropriate 
parameters
4. Contract automatically:
- Takes flash loan  
- Executes swaps   
- Repays loan   
- Sends profit to owner

## Security Considerations
-Only contract owner can execute arbitrage
- Always verify minOut parameters
- Start with small amounts for testing
- Monitor gas fees on Arbitrum network

## Limitations
- Requires manual opportunity detection
- Profitability depends on market volatility
- Subject to liquidity risks

## License
MIT License - Use at your own risk. Smart 
contracts involve substantial risk - thorough 
auditing is recommended before mainnet use.