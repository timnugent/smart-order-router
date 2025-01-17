import { Percent } from '@uniswap/sdk-core';
import { Pool } from '@uniswap/v3-sdk';
import _ from 'lodash';
import { CurrencyAmount } from '.';
import { RouteWithValidQuote } from '../routers/alpha-router';
import { RouteSOR } from '../routers/router';

export const routeToString = (route: RouteSOR): string => {
  const routeStr = [];
  const tokenPath = _.map(route.tokenPath, (token) => `${token.symbol}`);
  const poolFeePath = _.map(
    route.pools,
    (pool) => ` -- ${pool.fee / 10000}% --> `
  );

  for (let i = 0; i < tokenPath.length; i++) {
    routeStr.push(tokenPath[i]);
    if (i < poolFeePath.length) {
      routeStr.push(poolFeePath[i]);
    }
  }

  return routeStr.join('');
};

export const routeAmountsToString = (routeAmounts: RouteWithValidQuote[]): string => {
  const total = _.reduce(
    routeAmounts,
    (total: CurrencyAmount, cur: RouteWithValidQuote) => {
      return total.add(cur.amount);
    },
    CurrencyAmount.fromRawAmount(routeAmounts[0]!.amount.currency, 0)
  );

  const routeStrings = _.map(routeAmounts, ({ route, amount }) => {
    const portion = amount.divide(total);
    const percent = new Percent(portion.numerator, portion.denominator);
    return `${percent.toFixed(2)}% = ${routeToString(route)}`;
  });

  return _.join(routeStrings, ', ');
};

export const routeAmountToString = (routeAmount: RouteWithValidQuote): string => {
  const { route, amount } = routeAmount;
  return `${amount.toExact()} = ${routeToString(route)}`;
};

export const poolToString = (p: Pool): string => {
  return `${p.token0.symbol}/${p.token1.symbol}/${p.fee / 10000}%`;
};
