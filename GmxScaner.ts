import { ethers } from 'ethers';
import { Token, CurrencyAmount, TradeType, Percent } from '@uniswap/sdk-core';
import { AlphaRouter, SwapType } from '@uniswap/smart-order-router';
import { JsonRpcProvider } from '@ethersproject/providers'; // нужен для Uniswap router (v5 provider)

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
  private minProfitThreshold = 0.5; // 0.5% minimum profit
  private gasEstimate = 500000n; // Gas estimate for arbitrage execution
  private chainId = 42161; // Arbitrum

  // GMX V2 contracts
  private gmxReaderAddress = '0xf60becbba223eea9495da3f606753867ec10d139';
  private gmxDataStoreAddress = '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8';

  // GMX Reader ABI
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
    this.provider = new ethers.JsonRpcProvider(providerUrl);

    // AlphaRouter требует ethers v5 провайдер
    const providerV5 = new JsonRpcProvider(providerUrl);

    this.alphaRouter = new AlphaRouter({
      chainId: this.chainId,
      provider: providerV5
    });
  }

  /**
   * Get token price from GMX
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
   * Get Uniswap price
   */
  private async getUniswapPrice(
    tokenA: TokenPair,
    tokenB: TokenPair,
    amountIn: number
  ): Promise<number | null> {
    try {
      const tokenIn = new Token(this.chainId, tokenA.address, tokenA.decimals, tokenA.symbol);
      const tokenOut = new Token(this.chainId, tokenB.address, tokenB.decimals, tokenB.symbol);

      const amountInWei = ethers.parseUnits(amountIn.toString(), tokenA.decimals);

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
    slippageTolerance: new Percent(5, 1000),
    type: SwapType.UNIVERSAL_ROUTER
}
      );

      if (!route) return null;

      return parseFloat(
        ethers.formatUnits(
          route.quote.quotient.toString(),
          tokenB.decimals
        )
      );
    } catch (error) {
      console.warn('Uniswap price fetch failed:', error);
      return null;
    }
  }

  // Остальные методы (scanArbitrageOpportunities, checkPairArbitrage, calculateProfit и т.д.)
  // остаются такими же, просто теперь Uniswap цены будут работать правильно
}

export { ArbitrageScanner, ArbitrageOpportunity };
