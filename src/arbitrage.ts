import { Exchange } from "./entities/Exchange";
import { Price } from "./entities/Price";
import { Position } from "./entities/Position";
import { Trade } from "./entities/Trade";
import { Balance } from "./entities/Balance";
import { AppDataSource } from "./db";
import logger from "./logger";

export interface Opportunity {
  type: "arbitrage" | "convergence";
  buyExchange: string;
  sellExchange: string;
  symbol: string;
  buyPrice: number;
  sellPrice: number;
  profit: number;
}

export async function monitorOpportunities(
  exchanges: Exchange[],
  symbols: string[],
  minVolume: number = 100,
  minProfit: number = 5,
  maxProfit: number = 1000,
  tradeAmount: number = 5,
  stopLossPercent: number = 5,
  stopLossTimeout: number = 3600000,
  convergenceRange: number = 5
): Promise<Opportunity[]> {
  const prices: { [key: string]: { [symbol: string]: { price: number; volume: number } } } = {};
  const opportunities: Opportunity[] = [];
  const priceRepository = AppDataSource.getRepository(Price);
  const positionRepository = AppDataSource.getRepository(Position);
  const tradeRepository = AppDataSource.getRepository(Trade);

  logger.info(`Iniciando monitoramento com ${exchanges.length} exchanges e símbolos: ${symbols.join(", ")}`);

  manageOpenPositions(exchanges, minProfit, maxProfit, stopLossPercent, stopLossTimeout, convergenceRange);

  const monitorLoop = async (): Promise<Opportunity[]> => {
    while (true) {
      await Promise.all(
        exchanges.map(async (ex: Exchange): Promise<void> => {
          const instance: any = ex.getInstance();
          prices[ex.name] = {};
          for (const symbol of symbols) {
            try {
              const ticker: { last: number; baseVolume: number } = await instance.fetchTicker(symbol);
              const price: number = ticker.last ?? 0;
              const volume: number = ticker.baseVolume ?? 0;
              prices[ex.name][symbol] = { price, volume };

              const priceEntry: Price = new Price();
              priceEntry.symbol = symbol;
              priceEntry.exchange = ex.name;
              priceEntry.price = price;
              priceEntry.volume = volume;
              priceEntry.timestamp = new Date();
              await priceRepository.save(priceEntry);
            } catch (error: unknown) {
              logger.error(`Erro ao buscar ticker para ${symbol} em ${ex.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        })
      );

      const priceEntries: Price[] = [];
      const spotExchanges: Exchange[] = exchanges.filter((ex: Exchange) => ex.type === "spot");
      const futuresExchanges: Exchange[] = exchanges.filter((ex: Exchange) => ex.type === "futures");

      for (const spotEx of spotExchanges) {
        for (const futuresEx of futuresExchanges) {
          for (const symbol of symbols) {
            const dataSpot = prices[spotEx.name]?.[symbol];
            const dataFutures = prices[futuresEx.name]?.[symbol];
            if (!dataSpot || !dataFutures) continue;

            const spotPrice: number = dataSpot.price;
            const futuresPrice: number = dataFutures.price;
            const spotVolume: number = dataSpot.volume;
            const futuresVolume: number = dataFutures.volume;

            if (spotVolume < minVolume || futuresVolume < minVolume) {
              logger.warn(`Volume insuficiente para ${symbol}: ${spotEx.name} (${spotVolume}), ${futuresEx.name} (${futuresVolume})`);
              continue;
            }

            const feeRate: number = 0.001; // Taxa padrão de 0.1%
            const netTradeAmount: number = tradeAmount / (1 + feeRate * 2); // Ajusta para taxas de compra e venda
            const amount: number = netTradeAmount / spotPrice;
            const costAfterFees: number = amount * spotPrice * (1 + feeRate * 2);
            logger.info(`Calculado para ${symbol}: amount=${amount.toFixed(4)} ${symbol.split('/')[0]}, cost=${costAfterFees.toFixed(2)} USDT (tradeAmount: ${tradeAmount} USDT, spotPrice: ${spotPrice} USDT/${symbol.split('/')[0]})`);

            try {
              const [spotBook, futuresBook] = await Promise.all([
                spotEx.getInstance().fetchOrderBook(symbol),
                futuresEx.getInstance().fetchOrderBook(symbol),
              ]);
              const buyVolume: number = spotBook.bids[0]?.[1] || 0;
              const sellVolume: number = futuresBook.asks[0]?.[1] || 0;

              if (buyVolume < amount || sellVolume < amount) {
                logger.warn(`Liquidez imediata insuficiente para ${symbol}: ${spotEx.name} (${buyVolume}), ${futuresEx.name} (${sellVolume})`);
                continue;
              }

              if (spotPrice < futuresPrice) {
                const profitGross: number = (futuresPrice - spotPrice) * amount;
                const profitNet: number = profitGross - profitGross * feeRate * 2;
                if (profitNet >= minProfit && profitNet <= maxProfit) {
                  const op: Opportunity = {
                    type: "arbitrage",
                    buyExchange: spotEx.name, // Compra apenas em spot
                    sellExchange: futuresEx.name, // Venda apenas em futures
                    symbol,
                    buyPrice: spotPrice,
                    sellPrice: futuresPrice,
                    profit: profitNet,
                  };
                  opportunities.push(op);
                  priceEntries.push(await createOpportunityEntry(op));
                }
              }
            } catch (error: unknown) {
              logger.error(`Erro ao buscar ordem para ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }

      if (priceEntries.length > 0) {
        await priceRepository.save(priceEntries);
      }

      if (opportunities.length > 0) {
        return opportunities;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
    }
  };

  return monitorLoop();
}

async function createOpportunityEntry(op: Opportunity): Promise<Price> {
  const entry: Price = new Price();
  entry.symbol = op.symbol;
  entry.exchange = `${op.buyExchange} -> ${op.sellExchange}`;
  entry.price = op.sellPrice - op.buyPrice;
  entry.timestamp = new Date();
  entry.opportunityType = op.type;
  entry.profit = op.profit;
  return entry;
}

export async function executeOpportunity(op: Opportunity, exchanges: Exchange[]): Promise<void> {
  const positionRepository = AppDataSource.getRepository(Position);
  const tradeRepository = AppDataSource.getRepository(Trade);
  const buyEx = exchanges.find((e: Exchange) => e.name === op.buyExchange && e.type === "spot");
  const sellEx = exchanges.find((e: Exchange) => e.name === op.sellExchange && e.type === "futures");

  if (!buyEx || !sellEx) {
    logger.error(`Exchange inválida para operação: ${op.buyExchange} deve ser spot e ${op.sellExchange} deve ser futures`);
    return;
  }

  const tradeAmount: number = 5; // Ajuste conforme CLI ou configuração
  const feeRate: number = 0.001; // Taxa padrão de 0.1%
  const netTradeAmount: number = tradeAmount / (1 + feeRate * 2); // Ajusta para taxas
  const amountBuy: number = Math.max(netTradeAmount, 3); // Garante mínimo de 3 USDT para Gate.io
  const amountSell: number = amountBuy / op.buyPrice; // Quantidade em moeda base

  try {
    const position: Position = new Position();
    position.symbol = op.symbol;
    position.exchange = op.buyExchange;
    position.amount = amountSell;
    position.buyPrice = op.buyPrice;
    position.stopLossPrice = op.buyPrice * (1 - 0.05);
    position.timestamp = new Date();
    position.closed = false;
    await positionRepository.save(position);

    const buyTrade: Trade = new Trade();
    buyTrade.symbol = op.symbol;
    buyTrade.exchange = op.buyExchange;
    buyTrade.type = "buy";
    buyTrade.amount = amountBuy; // Custo em USDT
    buyTrade.price = op.buyPrice;
    buyTrade.timestamp = new Date();

    try {
      const buyInstance: any = buyEx.getInstance();
      if (buyInstance.id.includes("gate")) {
        buyInstance.options['createMarketBuyOrderRequiresPrice'] = false;
        await buyInstance.createMarketBuyOrder(op.symbol, amountBuy); // Compra em spot com custo em USDT
      } else {
        await buyInstance.createMarketBuyOrder(op.symbol, amountSell); // Compra em spot com quantidade
      }
      buyTrade.success = true;
      logger.info(`Compra executada: ${op.symbol} em ${op.buyExchange} por ${op.buyPrice} (custo: ${amountBuy} USDT)`);
    } catch (error: unknown) {
      buyTrade.success = false;
      buyTrade.error = error instanceof Error ? error.message : String(error);
      logger.error(`Erro na compra de ${op.symbol}: ${buyTrade.error}`);
      await tradeRepository.save(buyTrade);
      return;
    }
    await tradeRepository.save(buyTrade);

    const sellTrade: Trade = new Trade();
    sellTrade.symbol = op.symbol;
    sellTrade.exchange = op.sellExchange;
    sellTrade.type = "sell";
    sellTrade.amount = amountSell;
    sellTrade.price = op.sellPrice;
    sellTrade.timestamp = new Date();

    try {
      const sellInstance: any = sellEx.getInstance();
      await sellInstance.createMarketSellOrder(op.symbol, amountSell); // Venda em futures
      sellTrade.success = true;
      logger.info(`Venda executada: ${op.type} em ${op.symbol} -> Lucro: ${op.profit}`);
      position.closed = false;
      position.sellPrice = op.sellPrice;
      position.profit = op.profit;
      await positionRepository.save(position);
    } catch (error: unknown) {
      sellTrade.success = false;
      sellTrade.error = error instanceof Error ? error.message : String(error);
      logger.error(`Erro na venda de ${op.symbol}: ${sellTrade.error}`);
    }
    await tradeRepository.save(sellTrade);
  } catch (error: unknown) {
    logger.error(`Erro na execução de ${op.symbol}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function manageOpenPositions(
  exchanges: Exchange[],
  minProfit: number,
  maxProfit: number,
  stopLossPercent: number,
  stopLossTimeout: number,
  convergenceRange: number
): Promise<void> {
  const positionRepository = AppDataSource.getRepository(Position);
  const tradeRepository = AppDataSource.getRepository(Trade);

  const checkPositions = async (): Promise<void> => {
    const openPositions: Position[] = await positionRepository.find({ where: { closed: false } });
    if (openPositions.length > 0) {
      logger.info(`Gerenciando ${openPositions.length} posições abertas`);
      for (const pos of openPositions) {
        await tryConvergenceForPosition(pos, exchanges, minProfit, maxProfit, stopLossPercent, stopLossTimeout, convergenceRange, tradeRepository);
      }
    }
    setTimeout(checkPositions, 60000);
  };

  checkPositions();
}

async function tryConvergenceForPosition(
  pos: Position,
  exchanges: Exchange[],
  minProfit: number,
  maxProfit: number,
  stopLossPercent: number,
  stopLossTimeout: number,
  convergenceRange: number,
  tradeRepository: any
): Promise<void> {
  const positionRepository = AppDataSource.getRepository(Position);
  const buyEx = exchanges.find((e: Exchange) => e.name === pos.exchange && e.type === "spot");
  const futuresExchanges = exchanges.filter((ex: Exchange) => ex.type === "futures");

  if (!buyEx || pos.closed || buyEx.type !== "spot") return;

  const instance: any = buyEx.getInstance();
  const futuresEx = futuresExchanges[0];
  if (!futuresEx) return;

  const spotPrice: number = await instance.fetchTicker(pos.symbol).then((ticker: any) => ticker.last ?? 0);
  const futuresPrice: number = await futuresEx.getInstance().fetchTicker(pos.symbol).then((ticker: any) => ticker.last ?? 0);

  const timeElapsed: number = Date.now() - pos.timestamp.getTime();
  const stopLossTriggered: boolean =
    spotPrice <= (pos.stopLossPrice || pos.buyPrice * (1 - stopLossPercent / 100)) || timeElapsed > stopLossTimeout;
  const convergenceDetected: boolean = Math.abs(spotPrice - futuresPrice) <= convergenceRange;

  if (convergenceDetected || stopLossTriggered) {
    const amount: number = pos.amount;
    const feeRate: number = 0.001;
    const sellCost: number = amount * spotPrice;
    const adjustedSellCost: number = Math.max(sellCost, 3); // Garante mínimo de 3 USDT

    const spotSellTrade: Trade = new Trade();
    spotSellTrade.symbol = pos.symbol;
    spotSellTrade.exchange = buyEx.name;
    spotSellTrade.type = "sell";
    spotSellTrade.amount = adjustedSellCost; // Custo em USDT
    spotSellTrade.price = spotPrice;
    spotSellTrade.timestamp = new Date();

    try {
      const sellInstance: any = buyEx.getInstance();
      if (sellInstance.id.includes("gate")) {
        sellInstance.options['createMarketBuyOrderRequiresPrice'] = false;
        await sellInstance.createMarketSellOrder(pos.symbol, adjustedSellCost / spotPrice); // Quantidade ajustada para custo mínimo
      } else {
        await sellInstance.createMarketSellOrder(pos.symbol, amount);
      }
      spotSellTrade.success = true;
      logger.info(`Venda na spot executada: ${pos.symbol} em ${buyEx.name} por ${spotPrice} (custo: ${adjustedSellCost.toFixed(2)} USDT)`);
    } catch (error: unknown) {
      spotSellTrade.success = false;
      spotSellTrade.error = error instanceof Error ? error.message : String(error);
      logger.error(`Erro ao vender na spot ${pos.symbol}: ${spotSellTrade.error}`);
      await tradeRepository.save(spotSellTrade);
      return;
    }
    await tradeRepository.save(spotSellTrade);

    const futuresBuyTrade: Trade = new Trade();
    futuresBuyTrade.symbol = pos.symbol;
    futuresBuyTrade.exchange = futuresEx.name;
    futuresBuyTrade.type = "buy";
    futuresBuyTrade.amount = amount;
    futuresBuyTrade.price = futuresPrice;
    futuresBuyTrade.timestamp = new Date();

    try {
      await futuresEx.getInstance().createMarketBuyOrder(pos.symbol, amount);
      futuresBuyTrade.success = true;
      logger.info(`Fechamento na futures executado: ${pos.symbol} em ${futuresEx.name} por ${futuresPrice}`);
      pos.closed = true;
      pos.sellPrice = spotPrice;
      pos.profit = (spotPrice - pos.buyPrice) * amount * (1 - feeRate * 2);
      await positionRepository.save(pos);
    } catch (error: unknown) {
      futuresBuyTrade.success = false;
      futuresBuyTrade.error = error instanceof Error ? error.message : String(error);
      logger.error(`Erro ao fechar na futures ${pos.symbol}: ${futuresBuyTrade.error}`);
    }
    await tradeRepository.save(futuresBuyTrade);

    if (spotSellTrade.success && futuresBuyTrade.success) {
      logger.info(`Operação concluída para ${pos.symbol}: Lucro Final: ${pos.profit}`);
    } else {
      logger.error(`Falha ao concluir operação para ${pos.symbol}`);
    }
  } else {
    logger.info(`Aguardando convergência para ${pos.symbol} comprado em ${pos.buyPrice}, spot: ${spotPrice}, futures: ${futuresPrice}`);
  }
}