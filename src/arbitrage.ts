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

const marketCache: { [key: string]: any } = {};

export async function monitorOpportunities(
  exchanges: Exchange[],
  symbols: string[],
  minVolume: number = 100,
  minProfit: number = 5,
  maxProfit: number = 1000,
  tradeAmount: number = 10, // Ajustado para 10 como padrão
  stopLossPercent: number = 5,
  stopLossTimeout: number = 3600000
): Promise<Opportunity[]> {
  const prices: {
    [key: string]: { [symbol: string]: { price: number; volume: number } };
  } = {};
  const opportunities: Opportunity[] = [];
  const priceRepository = AppDataSource.getRepository(Price);
  const positionRepository = AppDataSource.getRepository(Position);
  const tradeRepository = AppDataSource.getRepository(Trade);
  const balanceRepository = AppDataSource.getRepository(Balance);

  logger.info(
    `Iniciando monitoramento com ${
      exchanges.length
    } exchanges e símbolos: ${symbols.join(", ")}`
  );

  for (const ex of exchanges) {
    const instance = ex.getInstance();
    if (!marketCache[ex.name]) {
      marketCache[ex.name] = await instance.loadMarkets();
      logger.info(`Mercados carregados para ${ex.name} - ${JSON.stringify(marketCache[ex.name])}`);
    }
    const markets = marketCache[ex.name];
    for (const symbol of symbols) {
      if (!markets[symbol]) {
        logger.warn(`Par ${symbol} não suportado na exchange ${ex.name}`);
        continue;
      }
    }
  }

  manageOpenPositions(
    exchanges,
    minProfit,
    maxProfit,
    stopLossPercent,
    stopLossTimeout
  );

  const monitorLoop = async () => {
    while (true) {
      await Promise.all(
        exchanges.map(async (ex) => {
          const instance = ex.getInstance();
          prices[ex.name] = {};
          for (const symbol of symbols) {
            try {
              let price: number = 0;
              let volume: number = 0;
              if (ex.type === "futures") {
                const ticker = await (instance as any).fetchTicker(symbol);
                price = ticker.last ?? 0;
                volume = ticker.baseVolume ?? 0;
              } else {
                const ticker = await instance.fetchTicker(symbol);
                price = ticker.last ?? 0;
                volume = ticker.baseVolume ?? 0;
              }
              prices[ex.name][symbol] = { price, volume };

              const priceEntry = new Price();
              priceEntry.symbol = symbol;
              priceEntry.exchange = ex.name;
              priceEntry.price = price;
              priceEntry.volume = volume;
              priceEntry.timestamp = new Date();
              await priceRepository.save(priceEntry);
            } catch (error) {
              logger.error(`Erro ao buscar ticker para ${symbol} em ${ex.name}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        })
      );

      const priceEntries: Price[] = [];
      for (const symbol of symbols) {
        for (let i = 0; i < exchanges.length; i++) {
          for (let j = i + 1; j < exchanges.length; j++) {
            const ex1 = exchanges[i];
            const ex2 = exchanges[j];
            const data1 = prices[ex1.name]?.[symbol];
            const data2 = prices[ex2.name]?.[symbol];
            if (!data1 || !data2) continue;

            const price1 = data1.price;
            const price2 = data2.price;
            const volume1 = data1.volume;
            const volume2 = data2.volume;

            if (volume1 < minVolume || volume2 < minVolume) {
              logger.warn(
                `Volume insuficiente para ${symbol}: ${ex1.name} (${volume1}), ${ex2.name} (${volume2})`
              );
              continue;
            }

            const feeRate = 0.001;
            const amount = tradeAmount / price1;

            try {
              const [book1, book2] = await Promise.all([
                ex1.getInstance().fetchOrderBook(symbol),
                ex2.getInstance().fetchOrderBook(symbol),
              ]);
              const buyVolume = book1.bids[0]?.[1] || 0;
              const sellVolume = book2.asks[0]?.[1] || 0;

              if (buyVolume < amount || sellVolume < amount) {
                logger.warn(
                  `Liquidez imediata insuficiente para ${symbol}: ${ex1.name} (${buyVolume}), ${ex2.name} (${sellVolume})`
                );
                continue;
              }

              if (price1 < price2) {
                const profitGross = (price2 - price1) * amount;
                const profitNet = profitGross - profitGross * feeRate * 2;
                if (profitNet >= minProfit && profitNet <= maxProfit) {
                  const op: Opportunity = {
                    type: "arbitrage",
                    buyExchange: ex1.name,
                    sellExchange: ex2.name,
                    symbol,
                    buyPrice: price1,
                    sellPrice: price2,
                    profit: profitNet,
                  };
                  opportunities.push(op);
                  priceEntries.push(await createOpportunityEntry(op));
                }
              }

              if (
                ex1.type === "spot" &&
                ex2.type === "futures" &&
                Math.abs(price1 - price2) > 10
              ) {
                const profitEstimate =
                  Math.abs(price1 - price2) * amount * (1 - feeRate * 2);
                if (profitEstimate >= minProfit && profitEstimate <= maxProfit) {
                  const op: Opportunity = {
                    type: "convergence",
                    buyExchange: price1 < price2 ? ex1.name : ex2.name,
                    sellExchange: price1 < price2 ? ex2.name : ex1.name,
                    symbol,
                    buyPrice: Math.min(price1, price2),
                    sellPrice: Math.max(price1, price2),
                    profit: profitEstimate,
                  };
                  opportunities.push(op);
                  priceEntries.push(await createOpportunityEntry(op));
                }
              }
            } catch (error) {
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

      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  };

  return monitorLoop();
}

async function createOpportunityEntry(op: Opportunity): Promise<Price> {
  const entry = new Price();
  entry.symbol = op.symbol;
  entry.exchange = `${op.buyExchange} -> ${op.sellExchange}`;
  entry.price = op.sellPrice - op.buyPrice;
  entry.timestamp = new Date();
  entry.opportunityType = op.type;
  entry.profit = op.profit;
  return entry;
}

export async function executeOpportunity(
  op: Opportunity,
  exchanges: Exchange[]
) {
  const positionRepository = AppDataSource.getRepository(Position);
  const tradeRepository = AppDataSource.getRepository(Trade);
  const buyEx = exchanges.find((e) => e.name === op.buyExchange);
  const sellEx = exchanges.find((e) => e.name === op.sellExchange);
  const amount = 1000 / op.buyPrice;

  try {
    const position = new Position();
    position.symbol = op.symbol;
    position.exchange = op.buyExchange;
    position.amount = amount;
    position.buyPrice = op.buyPrice;
    position.stopLossPrice = op.buyPrice * (1 - 0.05);
    position.timestamp = new Date();
    position.closed = false;
    await positionRepository.save(position);

    const buyTrade = new Trade();
    buyTrade.symbol = op.symbol;
    buyTrade.exchange = op.buyExchange;
    buyTrade.type = "buy";
    buyTrade.amount = amount;
    buyTrade.price = op.buyPrice;
    buyTrade.timestamp = new Date();

    try {
      await buyEx?.getInstance().createMarketBuyOrder(op.symbol, amount);
      buyTrade.success = true;
      logger.info(
        `Compra executada: ${op.symbol} em ${op.buyExchange} por ${op.buyPrice}`
      );
    } catch (error: unknown) {
      buyTrade.success = false;
      buyTrade.error = error instanceof Error ? error.message : String(error);
      logger.error(`Erro na compra de ${op.symbol}: ${buyTrade.error}`);
    }
    await tradeRepository.save(buyTrade);

    const sellTrade = new Trade();
    sellTrade.symbol = op.symbol;
    sellTrade.exchange = op.sellExchange;
    sellTrade.type = "sell";
    sellTrade.amount = amount;
    sellTrade.price = op.sellPrice;
    sellTrade.timestamp = new Date();

    try {
      await sellEx?.getInstance().createMarketSellOrder(op.symbol, amount);
      sellTrade.success = true;
      logger.info(
        `Executado: ${op.type} em ${op.symbol} -> Lucro: ${op.profit}`
      );
      position.closed = true;
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Erro na execução de ${op.symbol}: ${errorMessage}`);
  }
}

async function manageOpenPositions(
  exchanges: Exchange[],
  minProfit: number,
  maxProfit: number,
  stopLossPercent: number,
  stopLossTimeout: number
) {
  const positionRepository = AppDataSource.getRepository(Position);
  const tradeRepository = AppDataSource.getRepository(Trade);

  const checkPositions = async () => {
    const openPositions = await positionRepository.find({
      where: { closed: false },
    });
    if (openPositions.length > 0) {
      logger.info(`Gerenciando ${openPositions.length} posições abertas`);
      for (const pos of openPositions) {
        await tryConvergenceForPosition(
          pos,
          exchanges,
          minProfit,
          maxProfit,
          stopLossPercent,
          stopLossTimeout,
          tradeRepository
        );
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
  tradeRepository: any
) {
  const positionRepository = AppDataSource.getRepository(Position);
  const buyEx = exchanges.find((e) => e.name === pos.exchange);
  const otherExchanges = exchanges.filter((e) => e.name !== pos.exchange);

  if (!buyEx || pos.closed) return;

  const instance = buyEx.getInstance();
  const currentPrice = await instance.fetchTicker(pos.symbol).then((ticker: { last: any; }) => ticker.last ?? 0);

  const timeElapsed = Date.now() - pos.timestamp.getTime();
  const stopLossTriggered =
    currentPrice <=
      (pos.stopLossPrice || pos.buyPrice * (1 - stopLossPercent / 100)) ||
    timeElapsed > stopLossTimeout;

  for (const sellEx of otherExchanges) {
    const sellInstance = sellEx.getInstance();
    const sellPrice = await sellInstance.fetchTicker(pos.symbol).then((ticker: { last: any; }) => ticker.last ?? 0);

    const feeRate = 0.001;
    const profit = (sellPrice - pos.buyPrice) * pos.amount * (1 - feeRate * 2);

    const sellTrade = new Trade();
    sellTrade.symbol = pos.symbol;
    sellTrade.exchange = sellEx.name;
    sellTrade.type = "sell";
    sellTrade.amount = pos.amount;
    sellTrade.price = sellPrice;
    sellTrade.timestamp = new Date();

    if (profit >= minProfit && profit <= maxProfit) {
      try {
        await sellInstance.createMarketSellOrder(pos.symbol, pos.amount);
        sellTrade.success = true;
        logger.info(
          `Convergência executada: Vendido ${pos.symbol} em ${sellEx.name} por ${sellPrice}, Lucro: ${profit}`
        );
        pos.closed = true;
        pos.sellPrice = sellPrice;
        pos.profit = profit;
        await positionRepository.save(pos);
        await tradeRepository.save(sellTrade);
        break;
      } catch (error: unknown) {
        sellTrade.success = false;
        sellTrade.error = error instanceof Error ? error.message : String(error);
        logger.error(`Erro ao vender ${pos.symbol} em ${sellEx.name}: ${sellTrade.error}`);
        await tradeRepository.save(sellTrade);
      }
    } else if (stopLossTriggered) {
      try {
        await sellInstance.createMarketSellOrder(pos.symbol, pos.amount);
        sellTrade.success = true;
        logger.warn(
          `Stop-loss executado: Vendido ${pos.symbol} em ${sellEx.name} por ${sellPrice}, Perda: ${profit}`
        );
        pos.closed = true;
        pos.sellPrice = sellPrice;
        pos.profit = profit;
        await positionRepository.save(pos);
        await tradeRepository.save(sellTrade);
        break;
      } catch (error: unknown) {
        sellTrade.success = false;
        sellTrade.error = error instanceof Error ? error.message : String(error);
        logger.error(`Erro no stop-loss de ${pos.symbol}: ${sellTrade.error}`);
        await tradeRepository.save(sellTrade);
      }
    }
  }

  if (!pos.closed) {
    logger.info(
      `Aguardando convergência para ${pos.symbol} comprado em ${pos.buyPrice}, atual: ${currentPrice}`
    );
  }
}