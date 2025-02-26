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
  tradeAmount: number = 5,
  stopLossPercent: number = 5,
  stopLossTimeout: number = 3600000,
  convergenceRange: number = 5 // Novo parâmetro
): Promise<Opportunity[]> {
  const prices: {
    [key: string]: { [symbol: string]: { price: number; volume: number } };
  } = {};
  const opportunities: Opportunity[] = [];
  const priceRepository = AppDataSource.getRepository(Price);
  const positionRepository = AppDataSource.getRepository(Position);
  const tradeRepository = AppDataSource.getRepository(Trade);

  logger.info(
    `Iniciando monitoramento com ${
      exchanges.length
    } exchanges e símbolos: ${symbols.join(", ")}`
  );

  for (const ex of exchanges) {
    const instance = ex.getInstance();
    if (!marketCache[ex.name]) {
      marketCache[ex.name] = await instance.loadMarkets();
      logger.info(`Mercados carregados para ${ex.name}`);
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
    stopLossTimeout,
    convergenceRange
  );

  const monitorLoop = async () => {
    while (true) {
      await Promise.all(
        exchanges.map(async (ex) => {
          const instance = ex.getInstance();
          prices[ex.name] = {};
          for (const symbol of symbols) {
            try {
              const ticker = await instance.fetchTicker(symbol);
              const price = ticker.last ?? 0;
              const volume = ticker.baseVolume ?? 0;
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
        const spotExchanges = exchanges.filter(ex => ex.type === "spot");
        const futuresExchanges = exchanges.filter(ex => ex.type === "futures");

        for (const spotEx of spotExchanges) {
          for (const futuresEx of futuresExchanges) {
            const dataSpot = prices[spotEx.name]?.[symbol];
            const dataFutures = prices[futuresEx.name]?.[symbol];
            if (!dataSpot || !dataFutures) continue;

            const spotPrice = dataSpot.price;
            const futuresPrice = dataFutures.price;
            const spotVolume = dataSpot.volume;
            const futuresVolume = dataFutures.volume;

            if (spotVolume < minVolume || futuresVolume < minVolume) {
              logger.warn(
                `Volume insuficiente para ${symbol}: ${spotEx.name} (${spotVolume}), ${futuresEx.name} (${futuresVolume})`
              );
              continue;
            }

            const feeRate = 0.001;
            const amount = tradeAmount / spotPrice;

            try {
              const [spotBook, futuresBook] = await Promise.all([
                spotEx.getInstance().fetchOrderBook(symbol),
                futuresEx.getInstance().fetchOrderBook(symbol),
              ]);
              const buyVolume = spotBook.bids[0]?.[1] || 0;
              const sellVolume = futuresBook.asks[0]?.[1] || 0;

              if (buyVolume < amount || sellVolume < amount) {
                logger.warn(
                  `Liquidez imediata insuficiente para ${symbol}: ${spotEx.name} (${buyVolume}), ${futuresEx.name} (${sellVolume})`
                );
                continue;
              }

              if (spotPrice < futuresPrice) {
                const profitGross = (futuresPrice - spotPrice) * amount;
                const profitNet = profitGross - profitGross * feeRate * 2;
                if (profitNet >= minProfit && profitNet <= maxProfit) {
                  const op: Opportunity = {
                    type: "arbitrage",
                    buyExchange: spotEx.name,
                    sellExchange: futuresEx.name,
                    symbol,
                    buyPrice: spotPrice,
                    sellPrice: futuresPrice,
                    profit: profitNet,
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
  const amount = op.profit / (op.sellPrice - op.buyPrice); // Calcula o amount baseado no lucro

  try {
    const position = new Position();
    position.symbol = op.symbol;
    position.exchange = op.buyExchange;
    position.amount = amount;
    position.buyPrice = op.buyPrice;
    position.stopLossPrice = op.buyPrice * (1 - 0.05); // Ajustar conforme stopLossPercent
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
        `Venda executada: ${op.type} em ${op.symbol} -> Lucro: ${op.profit}`
      );
      position.closed = false; // Mantém aberta para convergência
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
  stopLossTimeout: number,
  convergenceRange: number
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
          convergenceRange,
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
  convergenceRange: number,
  tradeRepository: any
) {
  const positionRepository = AppDataSource.getRepository(Position);
  const buyEx = exchanges.find((e) => e.name === pos.exchange);
  const futuresExchanges = exchanges.filter(ex => ex.type === "futures");

  if (!buyEx || pos.closed || buyEx.type !== "spot") return;

  const instance = buyEx.getInstance();
  const futuresEx = futuresExchanges[0]; // Assume uma exchange futures disponível
  if (!futuresEx) return;

  const spotPrice = await instance.fetchTicker(pos.symbol).then((ticker: { last: any; }) => ticker.last ?? 0);
  const futuresPrice = await futuresEx.getInstance().fetchTicker(pos.symbol).then((ticker: { last: any; }) => ticker.last ?? 0);

  const timeElapsed = Date.now() - pos.timestamp.getTime();
  const stopLossTriggered =
    spotPrice <= (pos.stopLossPrice || pos.buyPrice * (1 - stopLossPercent / 100)) ||
    timeElapsed > stopLossTimeout;
  const convergenceDetected = Math.abs(spotPrice - futuresPrice) <= convergenceRange;

  if (convergenceDetected || stopLossTriggered) {
    const amount = pos.amount;
    const feeRate = 0.001;

    // Venda na spot
    const spotSellTrade = new Trade();
    spotSellTrade.symbol = pos.symbol;
    spotSellTrade.exchange = buyEx.name;
    spotSellTrade.type = "sell";
    spotSellTrade.amount = amount;
    spotSellTrade.price = spotPrice;
    spotSellTrade.timestamp = new Date();

    try {
      await instance.createMarketSellOrder(pos.symbol, amount);
      spotSellTrade.success = true;
      logger.info(`Venda na spot executada: ${pos.symbol} em ${buyEx.name} por ${spotPrice}`);
    } catch (error: unknown) {
      spotSellTrade.success = false;
      spotSellTrade.error = error instanceof Error ? error.message : String(error);
      logger.error(`Erro ao vender na spot ${pos.symbol}: ${spotSellTrade.error}`);
    }
    await tradeRepository.save(spotSellTrade);

    // Compra na futures (fechamento da venda inicial)
    const futuresBuyTrade = new Trade();
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
      pos.sellPrice = spotPrice; // Preço final de venda na spot
      pos.profit = (spotPrice - pos.buyPrice) * amount * (1 - feeRate * 2); // Lucro ajustado
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
    logger.info(
      `Aguardando convergência para ${pos.symbol} comprado em ${pos.buyPrice}, spot: ${spotPrice}, futures: ${futuresPrice}`
    );
  }
}