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

class ArbitrageScanner {
  private provider!: ethers.JsonRpcProvider;
  private alphaRouter: AlphaRouter | null = null;
  private minProfitThreshold = 0.3;
  private gasEstimate = 800000n;
  private chainId = 42161;

  // Verified GMX V2 contract addresses for Arbitrum
  private gmxReaderAddress = '0xf60becbba223eea9495da3f606753867ec10d139';
  private gmxDataStoreAddress = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8';
  private gmxOracleAddress = '0xa11B501c2dd83Acd29F6727570f2502FAaa617F2'; // Oracle Store

  // Minimal but functional ABIs
  private gmxReaderABI = [
    'function getSwapAmountOut(address dataStore, tuple(address marketToken, address indexToken, address longToken, address shortToken) market, tuple(uint256 min, uint256 max) tokenInPrice, address tokenIn, uint256 amountIn, address tokenOut) external view returns (uint256)',
    'function getMarket(address dataStore, address marketToken) external view returns (tuple(address marketToken, address indexToken, address longToken, address shortToken))'
  ];

  private oracleABI = [
    'function getPrimaryPrice(address token) external view returns (tuple(uint256 min, uint256 max))'
  ];

  private erc20ABI = [
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function balanceOf(address) view returns (uint256)'
  ];

  private tokenPairs: TokenPair[] = [
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
    { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aeFc5B0f', symbol: 'WBTC', decimals: 8 },
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 }
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
    this.initializeProviders(providerUrl);
  }

  private async initializeProviders(providerUrl: string): Promise<void> {
    try {
      // Initialize ethers v6 provider
      this.provider = new ethers.JsonRpcProvider(providerUrl);
      
      // Verify we're on Arbitrum
      const network = await this.provider.getNetwork();
      if (Number(network.chainId) !== this.chainId) {
        console.warn(`⚠️  Warning: Expected Arbitrum (${this.chainId}), got chainId ${network.chainId}`);
      }

      // Initialize AlphaRouter with v5 provider
      const providerV5 = new JsonRpcProvider(providerUrl);
      this.alphaRouter = new AlphaRouter({ 
        chainId: this.chainId, 
        provider: providerV5 
      });

      console.log('✅ Providers initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize providers:', error);
      throw error;
    }
  }

  /**
   * Test connectivity to all required contracts
   */
  async testConnectivity(): Promise<boolean> {
    console.log('🔧 Testing contract connectivity...');
    
    try {
      // Test GMX Reader
      const reader = new ethers.Contract(this.gmxReaderAddress, this.gmxReaderABI, this.provider);
      const marketData = await reader.getMarket(this.gmxDataStoreAddress, this.gmxMarkets['WETH/USDC'].marketAddress);
      console.log('✅ GMX Reader connected:', marketData[0]);

      // Test token contracts
      for (const token of this.tokenPairs.slice(0, 2)) { // Test first 2 tokens
        const tokenContract = new ethers.Contract(token.address, this.erc20ABI, this.provider);
        const symbol = await tokenContract.symbol();
        console.log(`✅ ${symbol} token connected`);
      }

      // Test AlphaRouter
      if (!this.alphaRouter) {
        throw new Error('AlphaRouter not initialized');
      }
      console.log('✅ AlphaRouter initialized');

      return true;
    } catch (error) {
      console.error('❌ Connectivity test failed:', error);
      return false;
    }
  }

  /**
   * Scan for arbitrage opportunities with error handling
   */
  async scanArbitrageOpportunities(amountInUSD: number = 1000): Promise<ArbitrageOpportunity[]> {
    if (!this.alphaRouter) {
      throw new Error('AlphaRouter not initialized. Call testConnectivity() first.');
    }

    const opportunities: ArbitrageOpportunity[] = [];
    console.log(`🔍 Scanning for arbitrage opportunities with $${amountInUSD}...`);

    try {
      // Get ETH price for gas calculations
      const ethPrice = await this.getTokenPriceWithFallback('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 3500);

      // Process each market
      for (const [pairName, marketConfig] of Object.entries(this.gmxMarkets)) {
        console.log(`📊 Checking ${pairName}...`);
        
        try {
          const tokenA = this.tokenPairs.find(t => t.address === marketConfig.longToken);
          const tokenB = this.tokenPairs.find(t => t.address === marketConfig.shortToken);

          if (!tokenA || !tokenB) {
            console.warn(`⚠️  Tokens not found for ${pairName}`);
            continue;
          }

          // Get token A price and calculate amount
          const tokenAPrice = await this.getTokenPriceWithFallback(tokenA.address, 1);
          const amountInTokenA = amountInUSD / tokenAPrice;

          // Check arbitrage in both directions
          const opp1 = await this.checkArbitrageDirection(
            tokenA, tokenB, marketConfig, amountInTokenA, ethPrice
          );
          
          const tokenBPrice = await this.getTokenPriceWithFallback(tokenB.address, 1);
          const opp2 = await this.checkArbitrageDirection(
            tokenB, tokenA, marketConfig, amountInUSD / tokenBPrice, ethPrice
          );

          if (opp1) opportunities.push(opp1);
          if (opp2) opportunities.push(opp2);

        } catch (error) {
          console.warn(`⚠️  Error checking ${pairName}:`, (error as Error).message);
        }
      }

      // Filter and sort profitable opportunities
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
   * Check arbitrage opportunity in one direction with robust error handling
   */
  private async checkArbitrageDirection(
    tokenFrom: TokenPair,
    tokenTo: TokenPair,
    marketConfig: GMXMarketConfig,
    amountIn: number,
    ethPrice: number
  ): Promise<ArbitrageOpportunity | null> {
    try {
      const amountInWei = ethers.parseUnits(amountIn.toString(), tokenFrom.decimals);

      // Get quotes with timeout
      const [gmxQuote, uniswapQuote] = await Promise.allSettled([
        this.getGMXSwapQuoteWithTimeout(tokenFrom, tokenTo, marketConfig, amountInWei, 10000),
        this.getUniswapSwapQuoteWithTimeout(tokenFrom, tokenTo, amountInWei, 15000)
      ]);

      // Handle results
      const gmxAmount = gmxQuote.status === 'fulfilled' ? gmxQuote.value : null;
      const uniAmount = uniswapQuote.status === 'fulfilled' ? uniswapQuote.value : null;

      if (!gmxAmount || !uniAmount) {
        if (gmxQuote.status === 'rejected') {
          console.warn(`GMX quote failed: ${gmxQuote.reason}`);
        }
        if (uniswapQuote.status === 'rejected') {
          console.warn(`Uniswap quote failed: ${uniswapQuote.reason}`);
        }
        return null;
      }

      // Calculate prices
      const gmxPrice = Number(ethers.formatUnits(gmxAmount, tokenTo.decimals)) / amountIn;
      const uniswapPrice = Number(ethers.formatUnits(uniAmount, tokenTo.decimals)) / amountIn;

      // Determine best direction
      let direction: 'GMX_TO_UNI' | 'UNI_TO_GMX';
      let buyPrice: number;
      let sellPrice: number;

      if (gmxPrice > uniswapPrice) {
        direction = 'GMX_TO_UNI';
        buyPrice = gmxPrice;
        sellPrice = uniswapPrice;
      } else if (uniswapPrice > gmxPrice) {
        direction = 'UNI_TO_GMX';
        buyPrice = uniswapPrice;
        sellPrice = gmxPrice;
      } else {
        return null; // No arbitrage opportunity
      }

      // Calculate profit
      const profit = await this.calculateArbitrageProfit(
        amountIn, buyPrice, sellPrice, tokenFrom, tokenTo, direction, ethPrice
      );

      if (profit.profitPercent <= this.minProfitThreshold) {
        return null;
      }

      return {
        tokenA: tokenFrom.address,
        tokenB: tokenTo.address,
        gmxPrice,
        uniswapPrice,
        profitPercent: profit.profitPercent,
        direction,
        estimatedProfit: profit.estimatedProfit,
        gasEstimate: profit.gasCostUSD.toFixed(4),
        marketAddress: marketConfig.marketAddress,
        amountIn: amountInWei.toString(),
        amountOut: (direction === 'GMX_TO_UNI' ? gmxAmount : uniAmount).toString()
      };

    } catch (error) {
      console.warn(`Error in arbitrage direction check:`, (error as Error).message);
      return null;
    }
  }

  /**
   * Get GMX swap quote with timeout
   */
  private async getGMXSwapQuoteWithTimeout(
    tokenFrom: TokenPair,
    tokenTo: TokenPair,
    marketConfig: GMXMarketConfig,
    amountIn: bigint,
    timeoutMs: number
  ): Promise<bigint> {
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`GMX quote timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const reader = new ethers.Contract(this.gmxReaderAddress, this.gmxReaderABI, this.provider);

        const market = {
          marketToken: marketConfig.marketAddress,
          indexToken: marketConfig.indexToken,
          longToken: marketConfig.longToken,
          shortToken: marketConfig.shortToken
        };

        // Get token price with fallback
        const tokenPrice = await this.getTokenPriceStructWithFallback(tokenFrom.address);

        const amountOut = await reader.getSwapAmountOut(
          this.gmxDataStoreAddress,
          market,
          tokenPrice,
          tokenFrom.address,
          amountIn,
          tokenTo.address
        );

        clearTimeout(timeout);
        resolve(amountOut);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Get Uniswap swap quote with timeout
   */
  private async getUniswapSwapQuoteWithTimeout(
    tokenFrom: TokenPair,
    tokenTo: TokenPair,
    amountIn: bigint,
    timeoutMs: number
  ): Promise<bigint> {
    if (!this.alphaRouter) {
      throw new Error('AlphaRouter not initialized');
    }

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Uniswap quote timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const tokenIn = new Token(this.chainId, tokenFrom.address, tokenFrom.decimals, tokenFrom.symbol);
        const tokenOut = new Token(this.chainId, tokenTo.address, tokenTo.decimals, tokenTo.symbol);

        const currencyAmountIn = CurrencyAmount.fromRawAmount(tokenIn, amountIn.toString());

        const route = await this.alphaRouter!.route(
          currencyAmountIn,
          tokenOut,
          TradeType.EXACT_INPUT,
          {
            recipient: ethers.ZeroAddress,
            slippageTolerance: new Percent(50, 10000), // 0.5%
            type: SwapType.UNIVERSAL_ROUTER as any,
            deadline: Math.floor(Date.now() / 1000) + 1800
          }
        );

        clearTimeout(timeout);

        if (!route || !route.quote) {
          reject(new Error('No route found'));
          return;
        }

        resolve(BigInt(route.quote.quotient.toString()));
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Get token price with fallback values
   */
  private async getTokenPriceWithFallback(tokenAddress: string, fallbackPrice: number): Promise<number> {
    try {
      const priceStruct = await this.getTokenPriceStructWithFallback(tokenAddress);
      return (Number(ethers.formatUnits(priceStruct.min, 30)) + Number(ethers.formatUnits(priceStruct.max, 30))) / 2;
    } catch (error) {
      console.warn(`Using fallback price ${fallbackPrice} for ${tokenAddress}`);
      return fallbackPrice;
    }
  }

  /**
   * Get token price structure with fallback
   */
  private async getTokenPriceStructWithFallback(tokenAddress: string): Promise<{ min: bigint, max: bigint }> {
    try {
      // Try oracle first
      const oracle = new ethers.Contract(this.gmxOracleAddress, this.oracleABI, this.provider);
      const price = await oracle.getPrimaryPrice(tokenAddress);
      
      if (price && price.min && price.max) {
        return { min: price.min, max: price.max };
      }
    } catch (error) {
      console.warn(`Oracle failed for ${tokenAddress}, using fallback`);
    }

    // Fallback prices in 30 decimals
    const fallbackPrices: Record<string, bigint> = {
      '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1': ethers.parseUnits('3500', 30), // WETH
      '0x2f2a2543B76A4166549F7aaB2e75Bef0aeFc5B0f': ethers.parseUnits('70000', 30), // WBTC
      '0xaf88d065e77c8cC2239327C5EDb3A432268e5831': ethers.parseUnits('1', 30), // USDC
      '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9': ethers.parseUnits('1', 30), // USDT
    };

    const price = fallbackPrices[tokenAddress] || ethers.parseUnits('1', 30);
    return { min: price, max: price };
  }

  /**
   * Calculate profit with error handling
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
    try {
      const outputAmount = amountIn * buyPrice;
      const sellValue = outputAmount * sellPrice;
      const investmentValue = amountIn * buyPrice;
      const grossProfit = sellValue - investmentValue;

      // Gas costs
      const gasPrice = await this.getGasPriceWithFallback();
      const gasCostETH = Number(ethers.formatEther(this.gasEstimate * gasPrice));
      const gasCostUSD = gasCostETH * ethPrice;

      // Net profit
      const netProfit = grossProfit - gasCostUSD;
      const profitPercent = (netProfit / investmentValue) * 100;

      return {
        profitPercent,
        estimatedProfit: netProfit.toFixed(4),
        gasCostUSD
      };
    } catch (error) {
      console.warn('Error calculating profit:', error);
      return {
        profitPercent: 0,
        estimatedProfit: '0.0000',
        gasCostUSD: 0
      };
    }
  }

  /**
   * Get gas price with fallback
   */
  private async getGasPriceWithFallback(): Promise<bigint> {
    try {
      const feeData = await this.provider.getFeeData();
      return feeData.gasPrice ?? ethers.parseUnits('0.1', 'gwei');
    } catch (error) {
      console.warn('Using fallback gas price');
      return ethers.parseUnits('0.1', 'gwei');
    }
  }

  /**
   * Format opportunity for display
   */
  formatOpportunity(opportunity: ArbitrageOpportunity): string {
    const tokenA = this.tokenPairs.find(t => t.address === opportunity.tokenA)?.symbol || 'Unknown';
    const tokenB = this.tokenPairs.find(t => t.address === opportunity.tokenB)?.symbol || 'Unknown';
    
    return `
🎯 ${tokenA}/${tokenB} - ${opportunity.direction}
💰 Profit: $${opportunity.estimatedProfit} (${opportunity.profitPercent.toFixed(2)}%)
📊 GMX: ${opportunity.gmxPrice.toFixed(6)} | Uniswap: ${opportunity.uniswapPrice.toFixed(6)}
⛽ Gas: $${opportunity.gasEstimate}
📍 Market: ${opportunity.marketAddress.slice(0, 10)}...
    `.trim();
  }
}

// Example usage and testing
async function testScanner() {
  try {
    const scanner = new ArbitrageScanner('YOUR_RPC_URL_HERE');
    
    // Test connectivity first
    const connected = await scanner.testConnectivity();
    if (!connected) {
      console.error('❌ Connectivity test failed');
      return;
    }

    // Scan for opportunities
    const opportunities = await scanner.scanArbitrageOpportunities(1000);
    
    if (opportunities.length > 0) {
      console.log('\n🎯 Found arbitrage opportunities:');
      opportunities.forEach(opp => {
        console.log(scanner.formatOpportunity(opp));
        console.log('---');
      });
    } else {
      console.log('😔 No profitable opportunities found');
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

export { ArbitrageScanner, ArbitrageOpportunity, testScanner };
