import { Currency, Fraction, TradeType } from '@uniswap/sdk-core';
import {
  MethodParameters,
  Pool,
  Position,
  Route,
  SwapRouter,
  TickMath,
  Trade,
  SqrtPriceMath
} from '@uniswap/v3-sdk';
import { BigNumber, providers } from 'ethers';
import _ from 'lodash';
import { IMulticallProvider } from '../../providers';
import { IGasPriceProvider } from '../../providers/gas-price-provider';
import { IPoolProvider } from '../../providers/pool-provider';
import { IQuoteProvider } from '../../providers/quote-provider';
import {
  ISubgraphProvider,
  SubgraphPool,
} from '../../providers/subgraph-provider';
import { ITokenListProvider } from '../../providers/caching-token-list-provider';
import { ITokenProvider } from '../../providers/token-provider';
import { CurrencyAmount } from '../../util/amounts';
import { ChainId } from '../../util/chains';
import { log } from '../../util/log';
import { metric, MetricLoggerUnit } from '../../util/metric';
import { IRouter, ISwapToRatio, SwapConfig, SwapRoute } from '../router';
import { RouteWithValidQuote } from './entities/route-with-valid-quote';
import { getBestSwapRoute } from './functions/best-swap-route';
import { computeAllRoutes } from './functions/compute-all-routes';
import { calculateRatioAmountIn } from './functions/calculate-ratio-amount-in';
import {
  CandidatePoolsBySelectionCriteria,
  getCandidatePools,
} from './functions/get-candidate-pools';
import { IGasModelFactory } from './gas-models/gas-model';
import JSBI from 'jsbi'

export type AlphaRouterParams = {
  chainId: ChainId;
  provider: providers.BaseProvider;
  multicall2Provider: IMulticallProvider;
  subgraphProvider: ISubgraphProvider;
  poolProvider: IPoolProvider;
  quoteProvider: IQuoteProvider;
  tokenProvider: ITokenProvider;
  gasPriceProvider: IGasPriceProvider;
  gasModelFactory: IGasModelFactory;
  blockedTokenListProvider?: ITokenListProvider;
};

export type AlphaRouterConfig = {
  blockNumber?: number;
  topN: number;
  topNDirectSwaps: number;
  topNTokenInOut: number;
  topNSecondHop: number;
  topNWithEachBaseToken: number;
  topNWithBaseToken: number;
  topNWithBaseTokenInSet: boolean;
  maxSwapsPerPath: number;
  minSplits: number;
  maxSplits: number;
  distributionPercent: number;
};

export const DEFAULT_CONFIG: AlphaRouterConfig = {
  topN: 4,
  topNDirectSwaps: 2,
  topNTokenInOut: 4,
  topNSecondHop: 2,
  topNWithEachBaseToken: 2,
  topNWithBaseToken: 10,
  topNWithBaseTokenInSet: false,
  maxSwapsPerPath: 3,
  minSplits: 1,
  maxSplits: 5,
  distributionPercent: 5,
};

export class AlphaRouter implements IRouter<AlphaRouterConfig>, ISwapToRatio<AlphaRouterConfig> {
  protected chainId: ChainId;
  protected provider: providers.BaseProvider;
  protected multicall2Provider: IMulticallProvider;
  protected subgraphProvider: ISubgraphProvider;
  protected poolProvider: IPoolProvider;
  protected quoteProvider: IQuoteProvider;
  protected tokenProvider: ITokenProvider;
  protected gasPriceProvider: IGasPriceProvider;
  protected gasModelFactory: IGasModelFactory;
  protected blockedTokenListProvider?: ITokenListProvider;

  constructor({
    chainId,
    provider,
    multicall2Provider,
    poolProvider,
    quoteProvider,
    tokenProvider,
    blockedTokenListProvider,
    subgraphProvider,
    gasPriceProvider,
    gasModelFactory,
  }: AlphaRouterParams) {
    this.chainId = chainId;
    this.provider = provider;
    this.multicall2Provider = multicall2Provider;
    this.poolProvider = poolProvider;
    this.quoteProvider = quoteProvider;
    this.blockedTokenListProvider = blockedTokenListProvider;
    this.tokenProvider = tokenProvider;
    this.subgraphProvider = subgraphProvider;
    this.gasPriceProvider = gasPriceProvider;
    this.gasModelFactory = gasModelFactory;
  }

  public async routeToRatio(
    token0Balance: CurrencyAmount,
    token1Balance: CurrencyAmount,
    position: Position,
    swapConfig?: SwapConfig,
    routingConfig = DEFAULT_CONFIG
  ): Promise<SwapRoute<TradeType.EXACT_INPUT> | null> {
      if (
        token0Balance.currency.wrapped.address.toLowerCase()
        > token1Balance.currency.wrapped.address.toLowerCase()
      ) {
        [token0Balance, token1Balance] = [token1Balance, token0Balance]
      }

      const precision = JSBI.BigInt('1' + '0'.repeat(18))

      const sqrtPriceX96 = position.pool.sqrtRatioX96
      const sqrtPriceX96Lower = TickMath.getSqrtRatioAtTick(position.tickLower)
      const sqrtPriceX96Upper = TickMath.getSqrtRatioAtTick(position.tickUpper)

      const token0Proportion = SqrtPriceMath.getAmount0Delta(
        sqrtPriceX96,
        sqrtPriceX96Upper,
        precision,
        true
      )
      const token1Proportion = SqrtPriceMath.getAmount1Delta(
        sqrtPriceX96,
        sqrtPriceX96Lower,
        precision,
        true
      )

      const amountToSwap = calculateRatioAmountIn(
        new Fraction(token0Proportion, token1Proportion),
        position.pool.token0Price,
        token0Balance,
        token1Balance,
      )

      return this.routeExactIn(
        amountToSwap.currency,
        amountToSwap.currency == token0Balance.currency
          ? token1Balance.currency
          : token0Balance.currency,
        amountToSwap,
        swapConfig,
        routingConfig
      )
  }

  public async routeExactIn(
    currencyIn: Currency,
    currencyOut: Currency,
    amountIn: CurrencyAmount,
    swapConfig?: SwapConfig,
    routingConfig = DEFAULT_CONFIG
  ): Promise<SwapRoute<TradeType.EXACT_INPUT> | null> {
    return this.route<TradeType.EXACT_INPUT>(
      currencyIn,
      currencyOut,
      amountIn,
      TradeType.EXACT_INPUT,
      swapConfig,
      routingConfig
    );
  }

  public async routeExactOut(
    currencyIn: Currency,
    currencyOut: Currency,
    amountOut: CurrencyAmount,
    swapConfig?: SwapConfig,
    routingConfig = DEFAULT_CONFIG
  ): Promise<SwapRoute<TradeType.EXACT_OUTPUT> | null> {
    return this.route<TradeType.EXACT_OUTPUT>(
      currencyIn,
      currencyOut,
      amountOut,
      TradeType.EXACT_OUTPUT,
      swapConfig,
      routingConfig
    );
  }

  private async route<TTradeType extends TradeType>(
    currencyIn: Currency,
    currencyOut: Currency,
    amount: CurrencyAmount,
    swapType: TTradeType,
    swapConfig?: SwapConfig,
    routingConfig = DEFAULT_CONFIG
  ): Promise<SwapRoute<TTradeType> | null> {
    const tokenIn = currencyIn.wrapped;
    const tokenOut = currencyOut.wrapped;

    // Get a block number to specify in all our calls. Ensures data we fetch from chain is
    // from the same block.
    const blockNumber =
      routingConfig.blockNumber ?? this.provider.getBlockNumber();

    // Fetch all the pools that we will consider routing via. There are thousands
    // of pools, so we filter them to a set of candidate pools that we expect will
    // result in good prices.
    const { poolAccessor, candidatePools } = await getCandidatePools({
      tokenIn,
      tokenOut,
      tokenProvider: this.tokenProvider,
      blockedTokenListProvider: this.blockedTokenListProvider,
      poolProvider: this.poolProvider,
      routeType: swapType,
      subgraphProvider: this.subgraphProvider,
      routingConfig,
      chainId: this.chainId,
    });
    const pools = poolAccessor.getAllPools();

    // Get an estimate of the gas price to use when estimating gas cost of different routes.
    const beforeGas = Date.now();
    const { gasPriceWei } = await this.gasPriceProvider.getGasPrice();

    metric.putMetric(
      'GasPriceLoad',
      Date.now() - beforeGas,
      MetricLoggerUnit.Milliseconds
    );

    const quoteToken = swapType == TradeType.EXACT_INPUT ? tokenOut : tokenIn;

    const gasModel = this.gasModelFactory.buildGasModel(
      this.chainId,
      gasPriceWei,
      poolAccessor,
      quoteToken
    );

    // Given all our candidate pools, compute all the possible ways to route from tokenIn to tokenOut.
    const { maxSwapsPerPath } = routingConfig;
    const routes = computeAllRoutes(tokenIn, tokenOut, pools, maxSwapsPerPath);

    if (routes.length == 0) {
      return null;
    }

    // Generate our distribution of amounts, i.e. fractions of the input amount.
    // We will get quotes for fractions of the input amount for different routes, then
    // combine to generate split routes.
    const [percents, amounts] = this.getAmountDistribution(
      amount,
      routingConfig
    );

    // For all our routes, and all the fractional amounts, fetch quotes on-chain.
    const quoteFn =
      swapType == TradeType.EXACT_INPUT
        ? this.quoteProvider.getQuotesManyExactIn.bind(this.quoteProvider)
        : this.quoteProvider.getQuotesManyExactOut.bind(this.quoteProvider);

    const beforeQuotes = Date.now();
    const { routesWithQuotes, blockNumber: blockNumberBN } = await quoteFn(
      amounts,
      routes,
      { blockNumber }
    );

    metric.putMetric(
      'QuotesLoad',
      Date.now() - beforeQuotes,
      MetricLoggerUnit.Milliseconds
    );

    metric.putMetric(
      'QuotesFetched',
      _(routesWithQuotes)
        .map(([, quotes]) => quotes.length)
        .sum(),
      MetricLoggerUnit.Count
    );

    // Given all the quotes for all the amounts for all the routes, find the best combination.
    const beforeBestSwap = Date.now();
    const swapRouteRaw = getBestSwapRoute(
      amount,
      percents,
      routesWithQuotes,
      quoteToken,
      swapType,
      gasModel,
      routingConfig,
      this.poolProvider
    );

    if (!swapRouteRaw) {
      return null;
    }

    this.emitGasModelLog(swapRouteRaw.routes);

    const {
      quote,
      quoteGasAdjusted,
      estimatedGasUsed,
      routes: routeAmounts,
      estimatedGasUsedQuoteToken,
      estimatedGasUsedUSD,
    } = swapRouteRaw;

    // Build Trade object that represents the optimal swap.
    const trade = this.buildTrade<TTradeType>(
      currencyIn,
      currencyOut,
      swapType,
      routeAmounts
    );

    let methodParameters: MethodParameters | undefined;

    // If user provided recipient, deadline etc. we also generate the calldata required to execute
    // the swap and return it too.
    if (swapConfig) {
      methodParameters = this.buildMethodParameters(trade, swapConfig);
    }

    metric.putMetric(
      'FindBestSwapRoute',
      Date.now() - beforeBestSwap,
      MetricLoggerUnit.Milliseconds
    );

    this.emitPoolSelectionMetrics(swapRouteRaw, candidatePools);

    return {
      quote,
      quoteGasAdjusted,
      estimatedGasUsed,
      estimatedGasUsedQuoteToken,
      estimatedGasUsedUSD,
      gasPriceWei,
      route: routeAmounts,
      trade,
      methodParameters,
      blockNumber: blockNumberBN,
    };
  }

  // Note multiplications here can result in a loss of precision in the amounts (e.g. taking 50% of 101)
  // This is reconcilled at the end of the algorithm by adding any lost precision to one of
  // the splits in the route.
  private getAmountDistribution(
    amount: CurrencyAmount,
    routingConfig: AlphaRouterConfig
  ): [number[], CurrencyAmount[]] {
    const { distributionPercent } = routingConfig;
    let percents = [];
    let amounts = [];

    for (let i = 1; i <= 100 / distributionPercent; i++) {
      percents.push(i * distributionPercent);
      amounts.push(amount.multiply(new Fraction(i * distributionPercent, 100)));
    }

    return [percents, amounts];
  }

  private buildTrade<TTradeType extends TradeType>(
    tokenInCurrency: Currency,
    tokenOutCurrency: Currency,
    tradeType: TTradeType,
    routeAmounts: RouteWithValidQuote[]
  ): Trade<Currency, Currency, TTradeType> {
    const routes = _.map<
      RouteWithValidQuote,
      {
        route: Route<Currency, Currency>;
        inputAmount: CurrencyAmount;
        outputAmount: CurrencyAmount;
      }
    >(routeAmounts, (routeAmount: RouteWithValidQuote) => {
      const { route, amount, quote } = routeAmount;

      // The route, amount and quote are all in terms of wrapped tokens.
      // When constructing the Trade object the inputAmount/outputAmount must
      // use native currencies if specified by the user. This is so that the Trade knows to wrap/unwrap.
      if (tradeType == TradeType.EXACT_INPUT) {
        const amountCurrency = CurrencyAmount.fromFractionalAmount(
          tokenInCurrency,
          amount.numerator,
          amount.denominator
        );
        const quoteCurrency = CurrencyAmount.fromFractionalAmount(
          tokenOutCurrency,
          quote.numerator,
          quote.denominator
        );

        const routeCurrency = new Route(
          route.pools,
          amountCurrency.currency,
          quoteCurrency.currency
        );

        return {
          route: routeCurrency,
          inputAmount: amountCurrency,
          outputAmount: quoteCurrency,
        };
      } else {
        const quoteCurrency = CurrencyAmount.fromFractionalAmount(
          tokenInCurrency,
          quote.numerator,
          quote.denominator
        );

        const amountCurrency = CurrencyAmount.fromFractionalAmount(
          tokenOutCurrency,
          amount.numerator,
          amount.denominator
        );

        const routeCurrency = new Route(
          route.pools,
          quoteCurrency.currency,
          amountCurrency.currency
        );

        return {
          route: routeCurrency,
          inputAmount: quoteCurrency,
          outputAmount: amountCurrency,
        };
      }
    });

    const trade = Trade.createUncheckedTradeWithMultipleRoutes({
      routes,
      tradeType,
    });

    return trade;
  }

  private buildMethodParameters(
    trade: Trade<Currency, Currency, TradeType>,
    swapConfig: SwapConfig
  ): MethodParameters {
    const { recipient, slippageTolerance, deadline, inputTokenPermit } =
      swapConfig;

    const methodParameters = SwapRouter.swapCallParameters(trade, {
      recipient,
      slippageTolerance,
      deadline,
      inputTokenPermit,
    });

    return methodParameters;
  }

  private emitPoolSelectionMetrics(
    swapRouteRaw: {
      quote: CurrencyAmount;
      quoteGasAdjusted: CurrencyAmount;
      routes: RouteWithValidQuote[];
      estimatedGasUsed: BigNumber;
    },
    poolsBySelection: CandidatePoolsBySelectionCriteria
  ) {
    const { routes: routeAmounts } = swapRouteRaw;
    const poolAddressesUsed = new Set<string>();

    _(routeAmounts)
      .flatMap((routeAmount) => {
        const {
          route: { pools },
        } = routeAmount;
        return _.map(pools, (pool) =>
          Pool.getAddress(pool.token0, pool.token1, pool.fee).toLowerCase()
        );
      })
      .forEach((address: string) => {
        poolAddressesUsed.add(address);
      });

    _.forIn(
      poolsBySelection,
      (pools: SubgraphPool[], topNSelection: string) => {
        const topNUsed =
          _.findLastIndex(pools, (pool) =>
            poolAddressesUsed.has(pool.id.toLowerCase())
          ) + 1;
        metric.putMetric(
          _.capitalize(topNSelection),
          topNUsed,
          MetricLoggerUnit.Count
        );
      }
    );
  }

  private emitGasModelLog(routeWithQuotes: RouteWithValidQuote[]) {
    if (routeWithQuotes.length > 1) {
      return;
    }

    const routeWithQuote = routeWithQuotes[0]!;
    const {
      initializedTicksCrossedList,
      quoterGasEstimate,
      tradeType,
      rawQuote,
      route,
    } = routeWithQuote;
    const initTicksCrossedTotal = _.sum(initializedTicksCrossedList);

    log.info(
      {
        initTicksCrossedTotal,
        quoterGasEstimate: quoterGasEstimate.toString(),
        tradeType,
        rawQuote: rawQuote.toString(),
        numPools: route.pools.length,
        chainId: route.chainId,
        gasInfo: true,
      },
      'Log for gas model'
    );
  }
}
