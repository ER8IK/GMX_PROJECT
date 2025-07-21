# GMX Arbitrage Bot

A smart contract for performing arbitrage between GMX V2 and other DEXs (like Uniswap).

## Key Features

- Two-step arbitrage execution (GMX → DEX)
- Profit calculation and distribution
- Order cancellation handling
- Owner-only emergency functions

## Setup

1. Install dependencies:
```bash
forge install OpenZeppelin/openzeppelin-contracts
```

2. Configure environment:
```bash
.env
# Fill in your values in .env
```

## Deployment

```solidity
// Deploy with:
GMXArbitrageur arbitrageur = new GMXArbitrageur(
    gmxV2RouterAddress,
    uniswapRouterAddress
);
```

## Usage

### Create Arbitrage Order
```solidity
arbitrageur.createArbitrageOrder{value: executionFee}(
    borrowToken,
    borrowAmount,
    targetToken,
    gmxMarket,
    gmxMinOut,
    uniswapMinOut,
    executionFee,
    callbackGasLimit
);
```

### Cancel Order
```solidity
arbitrageur.cancelOrder(orderKey);
```

### Owner Functions
```solidity
// Set slippage tolerance (in basis points)
arbitrageur.setSlippageTolerance(50); // 0.5%

// Rescue tokens
arbitrageur.rescueTokens(tokenAddress);
```

## Testing
```bash
forge test -vv
```