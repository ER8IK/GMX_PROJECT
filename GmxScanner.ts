import { ethers } from 'ethers';
import { Token, CurrencyAmount, TradeType } from '@uniswap/sdk-core';
import { AlphaRouter } from '@uniswap/smart-order-router';

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
  private provider: ethers.Provider;
  private alphaRouter: AlphaRouter;
  private minProfitThreshold = 0.5; // 0.5% minimum profit
  private gasEstimate = 500000n; // Gas estimate for arbitrage execution
  private chainId = 42161; // Arbitrum

  // GMX V2 contracts
  private gmxReaderAddress = '0xf60becbba223eea9495da3f606753867ec10d139';
  private gmxDataStoreAddress = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8';
  
  // GMX Reader ABI
  private gmxReaderABI = [
    'function getPrices(address dataStore, address[] memory tokens) public view returns (uint256[] memory)',
    'function getMarket(address dataStore, address marketToken) public view returns (tuple(address, address, address)'
  ];

  // Token pairs with GMX market configuration
  private tokenPairs: TokenPair[] = [
    { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18 },
    { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aeFc5B0f', symbol: 'WBTC', decimals: 8 },
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', decimals: 6 },
    { address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', symbol: 'DAI', decimals: 18 }
  ];

  // GMX V2 market configurations
  private gmxMarkets: Record<string, GMXMarketConfig> = {
    'WETH/USDC': {
      marketAddress: '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336',
      longToken: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
      shortToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' // USDC
    },
    'WBTC/USDC': {
      marketAddress: '0x47c031236e19d024b42f8AE6780E44A573170703',
      longToken: '0x2f2a2543B76A4166549F7aaB2e75Bef0aeFc5B0f', // WBTC
      shortToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' // USDC
    }
  };

  constructor(providerUrl: string) {
    this.provider = new ethers.JsonRpcProvider(providerUrl);
    this.alphaRouter = new AlphaRouter({ 
      chainId: this.chainId, 
      provider: this.provider 
    });
  }

  /**
   * Scan for profitable arbitrage opportunities
   */
  async scanArbitrageOpportunities(amountInUSD: number = 1000): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];
    
    console.log('🔍 Scanning for arbitrage opportunities...');
    
    // Get ETH price for gas estimation
    const ethPrice = await this.getTokenPrice('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1');
    
    // Scan configured markets
    for (const [pairName, marketConfig] of Object.entries(this.gmxMarkets)) {
      try {
        const tokenA = this.tokenPairs.find(t => t.address === marketConfig.longToken)!;
        const tokenB = this.tokenPairs.find(t => t.address === marketConfig.shortToken)!;
        
        // Calculate amount in token units based on USD value
        const tokenAPrice = await this.getTokenPrice(tokenA.address);
        const amountInToken = amountInUSD / tokenAPrice;
        
        const opportunity = await this.checkPairArbitrage(
          tokenA, 
          tokenB,
          marketConfig.marketAddress,
          amountInToken,
          ethPrice
        );
        
        if (opportunity && opportunity.profitPercent > this.minProfitThreshold) {
          opportunities.push(opportunity);
        }
      } catch (error) {
        console.warn(`❌ Error checking ${pairName}:`, error);
      }
    }

    return opportunities.sort((a, b) => b.profitPercent - a.profitPercent);
  }

  /**
   * Check arbitrage opportunity between two tokens
   */
  private async checkPairArbitrage(
    tokenA: TokenPair, 
    tokenB: TokenPair,
    marketAddress: string,
    amountIn: number,
    ethPrice: number
  ): Promise<ArbitrageOpportunity | null> {
    const [gmxPrice, uniswapPrice] = await Promise.all([
      this.getGMXPrice(tokenA, tokenB, marketAddress),
      this.getUniswapPrice(tokenA, tokenB, amountIn)
    ]);

    if (!gmxPrice || !uniswapPrice) return null;

    // Calculate profit in both directions
    const gmxToUni = this.calculateProfit(
      amountIn, 
      gmxPrice, 
      uniswapPrice,
      tokenA,
      tokenB,
      'GMX_TO_UNI',
      ethPrice
    );
    
    const uniToGmx = this.calculateProfit(
      amountIn, 
      uniswapPrice, 
      gmxPrice,
      tokenA,
      tokenB,
      'UNI_TO_GMX',
      ethPrice
    );

    // Return the more profitable direction
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

    return null;
  }

  /**
   * Get token price from GMX oracles
   */
  private async getTokenPrice(tokenAddress: string): Promise<number> {
    const reader = new ethers.Contract(
      this.gmxReaderAddress, 
      this.gmxReaderABI, 
      this.provider
    );
    
    const prices = await reader.getPrices(
      this.gmxDataStoreAddress, 
      [tokenAddress]
    );
    
    return Number(ethers.formatUnits(prices[0], 30));
  }

  /**
   * Get price from GMX V2
   */
  private async getGMXPrice(
    tokenA: TokenPair, 
    tokenB: TokenPair,
    marketAddress: string
  ): Promise<number | null> {
    try {
      const tokenAPrice = await this.getTokenPrice(tokenA.address);
      const tokenBPrice = await this.getTokenPrice(tokenB.address);
      
      // Calculate price ratio (tokenA in terms of tokenB)
      return tokenAPrice / tokenBPrice;
    } catch (error) {
      console.warn('GMX price fetch failed:', error);
      return null;
    }
  }

  /**
   * Get price from Uniswap V3
   */
  private async getUniswapPrice(
    tokenA: TokenPair, 
    tokenB: TokenPair,
    amountIn: number
  ): Promise<number | null> {
    try {
      const tokenIn = new Token(this.chainId, tokenA.address, tokenA.decimals, tokenA.symbol);
      const tokenOut = new Token(this.chainId, tokenB.address, tokenB.decimals, tokenB.symbol);
      
      const amountInWei = ethers.parseUnits(
        amountIn.toString(), 
        tokenA.decimals
      );
      
      const currencyAmountIn = CurrencyAmount.fromRawAmount(
        tokenIn,
        amountInWei.toString()
      );

      const route = await this.alphaRouter.route(
        currencyAmountIn,
        tokenOut,
        TradeType.EXACT_INPUT,
        {
          recipient: ethers.ZeroAddress,
          slippageTolerance: 0.005, // 0.5%
          deadline: Math.floor(Date.now() / 1000) + 60 * 20, // 20 minutes
        }
      );

      if (!route) return null;

      // Convert output to tokenB units
      return parseFloat(ethers.formatUnits(
        route.quote.quotient.toString(),
        tokenB.decimals
      ));
    } catch (error) {
      console.warn('Uniswap price fetch failed:', error);
      return null;
    }
  }

  /**
   * Calculate profit metrics with gas costs
   */
  private calculateProfit(
    amountIn: number,
    buyPrice: number,
    sellPrice: number,
    tokenA: TokenPair,
    tokenB: TokenPair,
    direction: 'GMX_TO_UNI' | 'UNI_TO_GMX',
    ethPrice: number
  ) {
    // Calculate output amounts
    let outputAmount: number;
    let profit: number;
    
    if (direction === 'GMX_TO_UNI') {
      outputAmount = amountIn * buyPrice;
      profit = (outputAmount * sellPrice) - (amountIn * buyPrice);
    } else {
      outputAmount = amountIn * buyPrice;
      profit = (outputAmount * sellPrice) - amountIn;
    }
    
    // Calculate gas costs in USD
    const gasCostETH = Number(ethers.formatEther(
      this.gasEstimate * (await this.getGasPrice())
    ));
    
    const gasCostUSD = gasCostETH * ethPrice;
    
    // Net profit after gas costs
    const netProfit = profit - gasCostUSD;
    const profitPercent = (netProfit / (amountIn * buyPrice)) * 100;

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
    const feeData = await this.provider.getFeeData();
    return feeData.gasPrice || ethers.parseUnits('0.1', 'gwei');
  }

  /**
   * Execute arbitrage opportunity
   */
  async executeArbitrage(
    opportunity: ArbitrageOpportunity,
    wallet: ethers.Wallet,
    amountIn: string
  ): Promise<string> {
    console.log(`🚀 Executing ${opportunity.direction} arbitrage`);
    
    // Get token decimals
    const tokenA = this.tokenPairs.find(t => t.address === opportunity.tokenA)!;
    const tokenB = this.tokenPairs.find(t => t.address === opportunity.tokenB)!;
    
    // Calculate min outputs with slippage
    const gmxMinOut = opportunity.gmxPrice * 0.995; // 0.5% slippage
    const uniMinOut = opportunity.uniswapPrice * 0.995;
    
    // Get execution fee (0.01 ETH)
    const executionFee = ethers.parseEther('0.01');
    
    // Contract ABI (simplified)
    const contractABI = [
      'function createArbitrageOrder(address borrowToken, uint256 borrowAmount, address targetToken, address gmxMarket, uint256 gmxMinOut, uint256 uniswapMinOut, uint256 executionFee, uint256 callbackGasLimit) payable'
    ];
    
    const contract = new ethers.Contract(
      '0xYourContractAddress', // Replace with actual contract address
      contractABI,
      wallet
    );
    
    // Convert amount to token decimals
    const amountInWei = ethers.parseUnits(amountIn, tokenA.decimals);
    
    const tx = await contract.createArbitrageOrder(
      opportunity.tokenA,
      amountInWei,
      opportunity.tokenB,
      opportunity.marketAddress,
      ethers.parseUnits(gmxMinOut.toFixed(tokenB.decimals), tokenB.decimals),
      ethers.parseUnits(uniMinOut.toFixed(tokenA.decimals), tokenA.decimals),
      executionFee,
      500000,
      { value: executionFee }
    );

    return tx.hash;
  }

  /**
   * Real-time monitoring
   */
  async startMonitoring(intervalMs: number = 15000) {
    console.log('📡 Starting continuous monitoring...');
    
    while (true) {
      try {
        const opportunities = await this.scanArbitrageOpportunities();
        
        if (opportunities.length > 0) {
          console.log(`💰 Found ${opportunities.length} opportunities:`);
          opportunities.forEach((opp, i) => {
            console.log(
              `${i + 1}. ${opp.direction} ${opp.tokenA.substring(0, 6)}->${opp.tokenB.substring(0, 6)} | ` +
              `Profit: ${opp.profitPercent.toFixed(2)}% | ` +
              `Gas: $${opp.gasEstimate}`
            );
          });
        } else {
          console.log('⏳ No profitable opportunities');
        }
        
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      } catch (error) {
        console.error('Monitoring error:', error);
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
  }
}

// Usage example
async function main() {
  const scanner = new ArbitrageScanner(process.env.ARBITRUM_RPC_URL!);
  
  // Single scan
  const opportunities = await scanner.scanArbitrageOpportunities();
  console.log('Found opportunities:', opportunities);
  
  // Continuous monitoring
  await scanner.startMonitoring();
}

export { ArbitrageScanner, ArbitrageOpportunity };