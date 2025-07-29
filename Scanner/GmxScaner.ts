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
  amountIn: string;
  amountOut: string;
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
  indexToken: string;
}

interface GMXSwapParams {
  market: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
}

class ArbitrageScanner {
  private provider: ethers.JsonRpcProvider;
  private alphaRouter: AlphaRouter;
  private minProfitThreshold = 0.3; // Minimum profit threshold in percent
  private gasEstimate = 800000n; // Estimated gas units for arbitrage transaction
  private chainId = 42161; // Arbitrum chain ID

  // GMX V2 contract addresses
  private gmxReaderAddress = '0xf60becbba223eea9495da3f606753867ec10d139';
  private gmxDataStoreAddress = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8';
  private gmxExchangeRouterAddress = '0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8';

  // Enhanced GMX Reader ABI with market data functions
  private gmxReaderABI = [
    'function getMarketTokenPrice(address dataStore, tuple(address marketToken, address indexToken, address longToken, address shortToken) market, tuple(uint256, uint256) indexTokenPrice, tuple(uint256, uint256) longTokenPrice, tuple(uint256, uint256) shortTokenPrice, bytes32 pnlFactorType, bool maximize) view returns (int256, tuple(int256, int256, int256))',
    'function getSwapAmountOut(address dataStore, tuple(address marketToken, address indexToken, address longToken, address shortToken) market, tuple(uint256, uint256) tokenInPrice, address tokenIn, uint256 amountIn, address tokenOut) view returns (uint256)',
    'function getMarket(address dataStore, address marketToken) view returns (tuple(address marketToken, address indexToken, address longToken, address shortToken))',
    'function getMarketTokenPrice(address dataStore, tuple(address marketToken, address indexToken, address longToken, address shortToken) market, tuple(uint256, uint256) indexTokenPrice, tuple(uint256, uint256) longTokenPrice, tuple(uint256, uint256) shortTokenPrice, bytes32 pnlFactorType, bool maximize) view returns (int256, tuple(int256, int256, int256))'
  ];

  // Oracle ABI for price feeds
  private oracleABI = [
    'function getPrimaryPrice(address token) view returns (tuple(uint256 min, uint256 max))'
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
      indexToken: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      longToken: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      shortToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
    },
    'WBTC/USDC': {
      marketAddress: '0x47c031236e19d024b42f8AE6780E44A573170703',
      indexToken: '0x2f2a2543B76A4166549F7aaB2e75Bef0aeFc5B0f',
      longToken: '0x2f2a2543B76A4166549F7aaB2e75Bef0aeFc5B0f',
      shortToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
    }
  };

  constructor(providerUrl: string) {
    // Initialize ethers v6 provider for GMX interactions
    this.provider = new ethers.JsonRpcProvider(providerUrl);

    // Initialize ethers v5 provider for AlphaRouter compatibility
    const providerV5 = new JsonRpcProvider(providerUrl);

    // Initialize Uniswap AlphaRouter with v5 provider
    this.alphaRouter = new AlphaRouter({ 
      chainId: this.chainId, 
      provider: providerV5 
    });
  }

  /**
   * Scan arbitrage opportunities across configured GMX markets
   */
  async scanArbitrageOpportunities(amountInUSD: number = 1000): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];
    console.log(`🔍 Scanning for arbitrage opportunities with $${amountInUSD}...`);

    try {
      // Get current ETH price for gas calculations
      const ethPrice = await this.getTokenPrice('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1');

      // Process each market pair
      for (const [pairName, marketConfig] of Object.entries(this.gmxMarkets)) {
        console.log(`📊 Checking ${pairName}...`);
        
        try {
          const tokenA = this.tokenPairs.find(t => t.address === marketConfig.longToken)!;
          const tokenB = this.tokenPairs.find(t => t.address === marketConfig.shortToken)!;

          // Calculate amount in token A terms
          const tokenAPrice = await this.getTokenPrice(tokenA.address);
          const amountInTokenA = amountInUSD / tokenAPrice;

          // Check both directions for arbitrage opportunities
          const opportunities1 = await this.checkArbitrageDirection(
            tokenA, tokenB, marketConfig, amountInTokenA, ethPrice, 'A_TO_B'
          );
          
          const opportunities2 = await this.checkArbitrageDirection(
            tokenB, tokenA, marketConfig, amountInUSD / await this.getTokenPrice(tokenB.address), ethPrice, 'B_TO_A'
          );

          opportunities.push(...opportunities1, ...opportunities2);

        } catch (error) {
          console.warn(`❌ Error checking ${pairName}:`, (error as Error).message);
        }
      }

      // Filter profitable opportunities and sort by profit
      const profitableOpportunities = opportunities
        .filter(opp => opp.profitPercent > this.minProfitThreshold)
        .sort((a, b) => b.profitPercent - a.profitPercent);

      console.log(`✅ Found ${profitableOpportunities.length} profitable opportunities`);
      return profitableOpportunities;

    } catch (error) {
      console.error('❌ Error scanning opportunities:', error);
      return [];
    }
  }

  /**
   * Check arbitrage in a specific direction for a token pair
   */
  private async checkArbitrageDirection(
    tokenFrom: TokenPair,
    tokenTo: TokenPair,
    marketConfig: GMXMarketConfig,
    amountIn: number,
    ethPrice: number,
    direction: 'A_TO_B' | 'B_TO_A'
  ): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    try {
      const amountInWei = ethers.parseUnits(amountIn.toString(), tokenFrom.decimals);

      // Get quotes from both exchanges
      const [gmxQuote, uniswapQuote] = await Promise.all([
        this.getGMXSwapQuote(tokenFrom, tokenTo, marketConfig, amountInWei),
        this.getUniswapSwapQuote(tokenFrom, tokenTo, amountInWei)
      ]);

      if (!gmxQuote || !uniswapQuote) {
        return opportunities;
      }

      // Calculate effective prices (output/input ratio)
      const gmxPrice = Number(ethers.formatUnits(gmxQuote, tokenTo.decimals)) / amountIn;
      const uniswapPrice = Number(ethers.formatUnits(uniswapQuote, tokenTo.decimals)) / amountIn;

      // Check GMX -> Uniswap arbitrage
      if (gmxPrice > uniswapPrice) {
        const profit = await this.calculateArbitrageProfit(
          amountIn, gmxPrice, uniswapPrice, tokenFrom, tokenTo, 'GMX_TO_UNI', ethPrice
        );

        if (profit.profitPercent > this.minProfitThreshold) {
          opportunities.push({
            tokenA: tokenFrom.address,
            tokenB: tokenTo.address,
            gmxPrice,
            uniswapPrice,
            profitPercent: profit.profitPercent,
            direction: 'GMX_TO_UNI',
            estimatedProfit: profit.estimatedProfit,
            gasEstimate: profit.gasCostUSD.toFixed(4),
            marketAddress: marketConfig.marketAddress,
            amountIn: amountInWei.toString(),
            amountOut: gmxQuote.toString()
          });
        }
      }

      // Check Uniswap -> GMX arbitrage
      if (uniswapPrice > gmxPrice) {
        const profit = await this.calculateArbitrageProfit(
          amountIn, uniswapPrice, gmxPrice, tokenFrom, tokenTo, 'UNI_TO_GMX', ethPrice
        );

        if (profit.profitPercent > this.minProfitThreshold) {
          opportunities.push({
            tokenA: tokenFrom.address,
            tokenB: tokenTo.address,
            gmxPrice,
            uniswapPrice,
            profitPercent: profit.profitPercent,
            direction: 'UNI_TO_GMX',
            estimatedProfit: profit.estimatedProfit,
            gasEstimate: profit.gasCostUSD.toFixed(4),
            marketAddress: marketConfig.marketAddress,
            amountIn: amountInWei.toString(),
            amountOut: uniswapQuote.toString()
          });
        }
      }

    } catch (error) {
      console.warn(`Warning in direction check:`, (error as Error).message);
    }

    return opportunities;
  }

  /**
   * Get actual swap quote from GMX using the reader contract
   */
  private async getGMXSwapQuote(
    tokenFrom: TokenPair,
    tokenTo: TokenPair,
    marketConfig: GMXMarketConfig,
    amountIn: bigint
  ): Promise<bigint | null> {
    try {
      const reader = new ethers.Contract(this.gmxReaderAddress, this.gmxReaderABI, this.provider);

      // Create market struct
      const market = {
        marketToken: marketConfig.marketAddress,
        indexToken: marketConfig.indexToken,
        longToken: marketConfig.longToken,
        shortToken: marketConfig.shortToken
      };

      // Get token prices
      const tokenInPrice = await this.getTokenPriceStruct(tokenFrom.address);
      
      // Get swap amount out
      const amountOut = await reader.getSwapAmountOut(
        this.gmxDataStoreAddress,
        market,
        tokenInPrice,
        tokenFrom.address,
        amountIn,
        tokenTo.address
      );

      return amountOut;
    } catch (error) {
      console.warn(`GMX quote failed for ${tokenFrom.symbol}->${tokenTo.symbol}:`, (error as Error).message);
      return null;
    }
  }

  /**
   * Get swap quote from Uniswap using AlphaRouter
   */
  private async getUniswapSwapQuote(
    tokenFrom: TokenPair,
    tokenTo: TokenPair,
    amountIn: bigint
  ): Promise<bigint | null> {
    try {
      const tokenIn = new Token(this.chainId, tokenFrom.address, tokenFrom.decimals, tokenFrom.symbol);
      const tokenOut = new Token(this.chainId, tokenTo.address, tokenTo.decimals, tokenTo.symbol);

      const currencyAmountIn = CurrencyAmount.fromRawAmount(tokenIn, amountIn.toString());

      const route = await this.alphaRouter.route(
        currencyAmountIn, 
        tokenOut, 
        TradeType.EXACT_INPUT, 
        {
          recipient: ethers.ZeroAddress,
          slippageTolerance: new Percent(50, 10000), // 0.5% slippage
          type: SwapType.UNIVERSAL_ROUTER,
          deadline: Math.floor(Date.now() / 1000) + 1800 // 30 minutes
        }
      );

      if (!route || !route.quote) {
        return null;
      }

      return BigInt(route.quote.quotient.toString());
    } catch (error) {
      console.warn(`Uniswap quote failed for ${tokenFrom.symbol}->${tokenTo.symbol}:`, (error as Error).message);
      return null;
    }
  }

  /**
   * Get token price from GMX oracle
   */
  private async getTokenPrice(tokenAddress: string): Promise<number> {
    try {
      const priceStruct = await this.getTokenPriceStruct(tokenAddress);
      // Use average of min and max price
      return (Number(ethers.formatUnits(priceStruct.min, 30)) + Number(ethers.formatUnits(priceStruct.max, 30))) / 2;
    } catch (error) {
      console.warn(`Price fetch failed for ${tokenAddress}:`, error);
      throw error;
    }
  }

  /**
   * Get token price structure from GMX oracle
   */
  private async getTokenPriceStruct(tokenAddress: string): Promise<{ min: bigint, max: bigint }> {
    try {
      // Use a simple price oracle approach for now
      // In production, you should use the actual GMX Oracle contract
      const oracle = new ethers.Contract(
        '0xa11B501c2dd83Acd29F6727570f2502FAaa617F2', // GMX Oracle
        this.oracleABI,
        this.provider
      );

      const price = await oracle.getPrimaryPrice(tokenAddress);
      return { min: price.min, max: price.max };
    } catch (error) {
      // Fallback to fixed price structure if oracle fails
      console.warn(`Oracle price fetch failed, using fallback for ${tokenAddress}`);
      
      // Rough price estimates in 30 decimals (GMX format)
      const prices: Record<string, bigint> = {
        '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1': ethers.parseUnits('3500', 30), // WETH
        '0x2f2a2543B76A4166549F7aaB2e75Bef0aeFc5B0f': ethers.parseUnits('70000', 30), // WBTC
        '0xaf88d065e77c8cC2239327C5EDb3A432268e5831': ethers.parseUnits('1', 30), // USDC
        '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9': ethers.parseUnits('1', 30), // USDT
        '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1': ethers.parseUnits('1', 30) // DAI
      };

      const price = prices[tokenAddress] || ethers.parseUnits('1', 30);
      return { min: price, max: price };
    }
  }

  /**
   * Calculate arbitrage profit accounting for gas costs
   */
  private async calculateArbitrageProfit(
    amountIn: number,
    buyPrice: number,
    sellPrice: number,
    tokenFrom: TokenPair,
    tokenTo: TokenPair,
    direction: 'GMX_TO_UNI' | 'UNI_TO_GMX',
    ethPrice: number
  ) {
    // Calculate gross profit
    const outputAmount = amountIn * buyPrice;
    const sellValue = outputAmount * sellPrice;
    const investmentValue = amountIn * buyPrice;
    const grossProfit = sellValue - investmentValue;

    // Calculate gas costs
    const gasPrice = await this.getGasPrice();
    const gasCostETH = Number(ethers.formatEther(this.gasEstimate * gasPrice));
    const gasCostUSD = gasCostETH * ethPrice;

    // Net profit after gas
    const netProfit = grossProfit - gasCostUSD;
    const profitPercent = (netProfit / investmentValue) * 100;

    return {
      profitPercent,
      estimatedProfit: netProfit.toFixed(4),
      gasCostUSD
    };
  }

  /**
   * Get current gas price
   */
  private async getGasPrice(): Promise<bigint> {
    try {
      const feeData = await this.provider.getFeeData();
      return feeData.gasPrice ?? ethers.parseUnits('0.1', 'gwei');
    } catch (error) {
      console.warn('Failed to get gas price, using default');
      return ethers.parseUnits('0.1', 'gwei');
    }
  }

  /**
   * Execute arbitrage opportunity (placeholder implementation)
   */
  async executeArbitrage(
    opportunity: ArbitrageOpportunity,
    privateKey: string
  ): Promise<string> {
    console.log(`🚀 Executing arbitrage: ${opportunity.direction}`);
    console.log(`💰 Expected profit: $${opportunity.estimatedProfit} (${opportunity.profitPercent.toFixed(2)}%)`);

    try {
      const wallet = new ethers.Wallet(privateKey, this.provider);
      
      // Get token contracts
      const tokenFrom = this.tokenPairs.find(t => t.address === opportunity.tokenA)!;
      const tokenTo = this.tokenPairs.find(t => t.address === opportunity.tokenB)!;

      console.log(`📝 Trading ${tokenFrom.symbol} -> ${tokenTo.symbol}`);
      console.log(`📊 GMX Price: ${opportunity.gmxPrice.toFixed(6)}`);
      console.log(`📊 Uniswap Price: ${opportunity.uniswapPrice.toFixed(6)}`);

      // TODO: Implement actual arbitrage execution
      // This would involve:
      // 1. Check token balances and approvals
      // 2. Execute the first leg (buy on cheaper exchange)
      // 3. Execute the second leg (sell on more expensive exchange)
      // 4. Handle slippage and MEV protection

      console.log('⚠️  Arbitrage execution not implemented - returning placeholder hash');
      return '0x' + '0'.repeat(64);

    } catch (error) {
      console.error('❌ Arbitrage execution failed:', error);
      throw error;
    }
  }

  /**
   * Get formatted opportunity summary
   */
  formatOpportunity(opportunity: ArbitrageOpportunity): string {
    const tokenA = this.tokenPairs.find(t => t.address === opportunity.tokenA)?.symbol || 'Unknown';
    const tokenB = this.tokenPairs.find(t => t.address === opportunity.tokenB)?.symbol || 'Unknown';
    
    return `
🎯 ${tokenA}/${tokenB} - ${opportunity.direction}
💰 Profit: $${opportunity.estimatedProfit} (${opportunity.profitPercent.toFixed(2)}%)
📊 GMX: ${opportunity.gmxPrice.toFixed(6)} | Uniswap: ${opportunity.uniswapPrice.toFixed(6)}
⛽ Gas: $${opportunity.gasEstimate}
📍 Market: ${opportunity.marketAddress}
    `.trim();
  }
}

export { ArbitrageScanner, ArbitrageOpportunity };