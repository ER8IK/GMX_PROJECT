import { ethers } from 'ethers';
import { Token, CurrencyAmount, TradeType, Percent } from '@uniswap/sdk-core';
import { AlphaRouter, SwapType } from '@uniswap/smart-order-router';
import { JsonRpcProvider } from '@ethersproject/providers';

interface ArbitrageOpportunity {
  tokenA: string;
  tokenB: string;
  gmxPrice: number;
  uniswapPrice: number;
  profitPercent: number;
  direction: 'GMX_TO_UNI' | 'UNI_TO_GMX';
  estimatedProfit: string;
  gasEstimate: string;
  marketAddress: string;
}

interface TokenPair {
  address: string;
  symbol: string;
  decimals: number;
}

interface GMXMarketConfig {
  marketAddress: string;
  longToken: string;
  shortToken: string;
}

class ArbitrageScanner {
  private provider: ethers.JsonRpcProvider;
  private alphaRouter: AlphaRouter;
  private minProfitThreshold = 0.5; // Minimum profit threshold in percent
  private gasEstimate = 500000n; // Estimated gas units for arbitrage transaction
  private chainId = 42161; // Arbitrum chain ID

  private gmxReaderAddress = '0xf60becbba223eea9495da3f606753867ec10d139';
  private gmxDataStoreAddress = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8';

  private gmxReaderABI = [
    'function getPrices(address dataStore, address[] memory tokens) public view returns (uint256[] memory)',
    'function getMarket(address dataStore, address marketToken) public view returns (tuple(address, address, address))'
  ];

  private tokenPairs: TokenPair[] = [
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
    { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aeFc5B0f', symbol: 'WBTC', decimals: 8 },
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
    { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18 }
  ];

  private gmxMarkets: Record<string, GMXMarketConfig> = {
    'WETH/USDC': {
      marketAddress: '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336',
      longToken: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      shortToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
    },
    'WBTC/USDC': {
      marketAddress: '0x47c031236e19d024b42f8AE6780E44A573170703',
      longToken: '0x2f2a2543B76A4166549F7aaB2e75Bef0aeFc5B0f',
      shortToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
    }
  };

  constructor(providerUrl: string) {
    // Initialize ethers v6 JsonRpcProvider
    this.provider = new ethers.JsonRpcProvider(providerUrl);

    // Initialize ethers v5 provider for AlphaRouter compatibility
    const providerV5 = new JsonRpcProvider(providerUrl);

    // Initialize Uniswap AlphaRouter with v5 provider
    this.alphaRouter = new AlphaRouter({ chainId: this.chainId, provider: providerV5 });
  }

  /**
   * Scan arbitrage opportunities across configured GMX markets
   * @param amountInUSD - amount in USD to trade per opportunity
   * @returns array of profitable arbitrage opportunities
   */
  async scanArbitrageOpportunities(amountInUSD: number = 1000): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];
    console.log('🔍 Scanning for arbitrage opportunities...');

    // Get current ETH price from GMX oracle for gas cost calculation
    const ethPrice = await this.getTokenPrice('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'); // WETH address

    // Iterate through each configured GMX market pair
    for (const [pairName, marketConfig] of Object.entries(this.gmxMarkets)) {
      try {
        // Find tokens involved in this market
        const tokenA = this.tokenPairs.find(t => t.address === marketConfig.longToken)!;
        const tokenB = this.tokenPairs.find(t => t.address === marketConfig.shortToken)!;

        // Get token A price and convert USD amount to token units
        const tokenAPrice = await this.getTokenPrice(tokenA.address);
        const amountInToken = amountInUSD / tokenAPrice;

        // Check arbitrage opportunity for this pair and amount
        const opportunity = await this.checkPairArbitrage(
          tokenA,
          tokenB,
          marketConfig.marketAddress,
          amountInToken,
          ethPrice
        );

        // If profitable, add to list
        if (opportunity && opportunity.profitPercent > this.minProfitThreshold) {
          opportunities.push(opportunity);
        }
      } catch (error) {
        console.warn(`❌ Error checking ${pairName}:`, error);
      }
    }

    // Sort opportunities by profit descending
    return opportunities.sort((a, b) => b.profitPercent - a.profitPercent);
  }

  /**
   * Check arbitrage profit for a token pair in both directions
   */
  private async checkPairArbitrage(
    tokenA: TokenPair,
    tokenB: TokenPair,
    marketAddress: string,
    amountIn: number,
    ethPrice: number
  ): Promise<ArbitrageOpportunity | null> {
    // Fetch prices from GMX and Uniswap
    const [gmxPrice, uniswapPrice] = await Promise.all([
      this.getGMXPrice(tokenA, tokenB, marketAddress),
      this.getUniswapPrice(tokenA, tokenB, amountIn)
    ]);

    if (!gmxPrice || !uniswapPrice) return null;

    // Calculate profit for GMX->Uniswap direction
    const gmxToUni = await this.calculateProfit(
      amountIn,
      gmxPrice,
      uniswapPrice,
      tokenA,
      tokenB,
      'GMX_TO_UNI',
      ethPrice
    );

    // Calculate profit for Uniswap->GMX direction
    const uniToGmx = await this.calculateProfit(
      amountIn,
      uniswapPrice,
      gmxPrice,
      tokenA,
      tokenB,
      'UNI_TO_GMX',
      ethPrice
    );

    // Return the direction with higher positive profit
    if (gmxToUni.profitPercent > uniToGmx.profitPercent && gmxToUni.profitPercent > 0) {
      return {
        tokenA: tokenA.address,
        tokenB: tokenB.address,
        marketAddress,
        gmxPrice,
        uniswapPrice,
        profitPercent: gmxToUni.profitPercent,
        direction: 'GMX_TO_UNI',
        estimatedProfit: gmxToUni.estimatedProfit,
        gasEstimate: gmxToUni.gasCostUSD.toFixed(4)
      };
    } else if (uniToGmx.profitPercent > 0) {
      return {
        tokenA: tokenA.address,
        tokenB: tokenB.address,
        marketAddress,
        gmxPrice,
        uniswapPrice,
        profitPercent: uniToGmx.profitPercent,
        direction: 'UNI_TO_GMX',
        estimatedProfit: uniToGmx.estimatedProfit,
        gasEstimate: uniToGmx.gasCostUSD.toFixed(4)
      };
    }

    // No profitable arbitrage found
    return null;
  }

  /**
   * Fetch GMX price for tokenA/tokenB pair (price ratio)
   */
  private async getGMXPrice(tokenA: TokenPair, tokenB: TokenPair, marketAddress: string): Promise<number | null> {
    try {
      const tokenAPrice = await this.getTokenPrice(tokenA.address);
      const tokenBPrice = await this.getTokenPrice(tokenB.address);
      return tokenAPrice / tokenBPrice;
    } catch (error) {
      console.warn('GMX price fetch failed:', error);
      return null;
    }
  }

  /**
   * Fetch Uniswap price by routing the swap via AlphaRouter
   */
  private async getUniswapPrice(tokenA: TokenPair, tokenB: TokenPair, amountIn: number): Promise<number | null> {
    try {
      const tokenIn = new Token(this.chainId, tokenA.address, tokenA.decimals, tokenA.symbol);
      const tokenOut = new Token(this.chainId, tokenB.address, tokenB.decimals, tokenB.symbol);

      const amountInWei = ethers.parseUnits(amountIn.toString(), tokenA.decimals);

      const currencyAmountIn = CurrencyAmount.fromRawAmount(tokenIn, amountInWei.toString());

      const route = await this.alphaRouter.route(currencyAmountIn, tokenOut, TradeType.EXACT_INPUT, {
        recipient: ethers.ZeroAddress,
        slippageTolerance: new Percent(5, 1000), // 0.5% slippage tolerance
        type: SwapType.UNIVERSAL_ROUTER
      });

      if (!route) return null;

      // Return the output amount in tokenB units
      return parseFloat(ethers.formatUnits(route.quote.quotient.toString(), tokenB.decimals));
    } catch (error) {
      console.warn('Uniswap price fetch failed:', error);
      return null;
    }
  }

  /**
   * Fetch raw token price from GMX oracle by token address
   */
  private async getTokenPrice(tokenAddress: string): Promise<number> {
    const reader = new ethers.Contract(this.gmxReaderAddress, this.gmxReaderABI, this.provider);
    const prices = await reader.getPrices(this.gmxDataStoreAddress, [tokenAddress]);
    return Number(ethers.formatUnits(prices[0], 30)); // GMX returns price with 30 decimals
  }

  /**
   * Calculate profit percentage and estimated profit USD after gas costs
   */
  private async calculateProfit(
    amountIn: number,
    buyPrice: number,
    sellPrice: number,
    tokenA: TokenPair,
    tokenB: TokenPair,
    direction: 'GMX_TO_UNI' | 'UNI_TO_GMX',
    ethPrice: number
  ) {
    let outputAmount: number;
    let profit: number;

    if (direction === 'GMX_TO_UNI') {
      // Buy on GMX, sell on Uniswap
      outputAmount = amountIn * buyPrice;
      profit = (outputAmount * sellPrice) - (amountIn * buyPrice);
    } else {
      // Buy on Uniswap, sell on GMX
      outputAmount = amountIn * buyPrice;
      profit = (outputAmount * sellPrice) - amountIn;
    }

    // Get current gas price in wei
    const gasPrice = await this.getGasPrice();

    // Calculate gas cost in ETH and then USD
    const gasCostETH = Number(ethers.formatEther(this.gasEstimate * gasPrice));
    const gasCostUSD = gasCostETH * ethPrice;

    // Net profit after gas cost
    const netProfit = profit - gasCostUSD;

    // Profit percentage relative to investment
    const profitPercent = (netProfit / (amountIn * buyPrice)) * 100;

    return {
      profitPercent,
      estimatedProfit: netProfit.toFixed(4),
      gasCostUSD
    };
  }

  /**
   * Get current gas price from provider
   */
  private async getGasPrice(): Promise<bigint> {
    const feeData = await this.provider.getFeeData();
    return feeData.gasPrice ?? ethers.parseUnits('0.1', 'gwei');
  }

  /**
   * Placeholder for arbitrage execution function
   * You need to implement your own arbitrage transaction logic here
   */
  async executeArbitrage(
    opportunity: ArbitrageOpportunity,
    wallet: ethers.Wallet,
    amountIn: string
  ): Promise<string> {
    console.log(`🚀 Executing arbitrage direction: ${opportunity.direction}`);

    const tokenA = this.tokenPairs.find(t => t.address === opportunity.tokenA)!;
    const tokenB = this.tokenPairs.find(t => t.address === opportunity.tokenB)!;

    // Minimal amounts to receive considering slippage tolerance (0.5%)
    const gmxMinOut = opportunity.gmxPrice * 0.995;
    const uniMinOut = opportunity.uniswapPrice * 0.995;

    // Example execution fee placeholder
    const executionFee = ethers.parseEther('0.01');

    // Example contract ABI and address (replace with your arbitrage contract)
    const contractABI = [
      'function createArbitrageOrder(address borrowToken, uint256 borrowAmount, address targetToken, address gmxMarket, uint256 gmxMinOut, uint256 uniswapMinOut, uint256 executionFee, uint256 callbackGasLimit) payable'
    ];

    const contract = new ethers.Contract(
      '0xYourContractAddress', // TODO: replace with your deployed contract address
      contractABI,
      wallet
    );

    const amountInWei = ethers.parseUnits(amountIn, tokenA.decimals);

    // TODO: Implement actual call, example:
    /*
    const tx = await contract.createArbitrageOrder(
      opportunity.tokenA,
      amountInWei,
      opportunity.tokenB,
      opportunity.marketAddress,
      ethers.parseUnits(gmxMinOut.toFixed(tokenB.decimals), tokenB.decimals),
      ethers.parseUnits(uniMinOut.toFixed(tokenA.decimals), tokenA.decimals),
      executionFee,
      500000 // callbackGasLimit
    );

    return tx.hash;
    */

    // For now return dummy tx hash
    return '0x0000000000000000000000000000000000000000000000000000000000000000';
  }
}

export { ArbitrageScanner, ArbitrageOpportunity };