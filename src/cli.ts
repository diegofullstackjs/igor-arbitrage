import { program } from "commander";
import { initializeDatabase, AppDataSource } from "./db";
import { addExchange, getExchanges, updateCompatibleSymbols, Exchange } from "./exchanges";
import { monitorOpportunities, executeOpportunity, Opportunity } from "./arbitrage";
import { Price } from "./entities/Price";
import { CompatibleSymbol } from "./entities/CompatibleSymbol";
import { Position } from "./entities/Position";
import { Trade } from "./entities/Trade";
import { Balance } from "./entities/Balance";
import logger from "./logger";

// Interface para opções genéricas do Commander
interface CommandOptions {
  [key: string]: any;
}

// Interfaces para opções específicas de cada comando
interface AddExchangeOptions {
  name: string;
  type: "spot" | "futures";
  apiKey: string;
  secret: string;
}

interface RemoveExchangeOptions {
  name: string;
}

interface SyncOptions {
  exchanges?: string[];
}

interface CancelAllOrdersOptions {
  exchange?: string;
}

interface MonitorOptions {
  exchanges?: string[];
  symbols?: string[];
  auto?: boolean;
  minVolume: number;
  minProfit: number;
  maxProfit: number;
  stopLoss: number;
  timeout: number;
  tradeAmount: number;
  convergenceRange: number;
  symbolLimit: number;
  test?: boolean;
  allSymbols?: boolean;
}

interface PortfolioOptions {
  exchange?: string;
}

interface OrderbookOptions {
  exchange?: string;
}

interface CancelOrderOptions {
  id: number;
}

interface VolumeStatsOptions {
  symbol?: string;
}

// Comando para adicionar uma nova exchange
program
  .command("add-exchange")
  .description("Adicionar uma nova exchange")
  .option("-n, --name <name>", "Nome da exchange (ex.: gate, bybit)")
  .option("-t, --type <type>", "Tipo: spot ou futures")
  .option("-k, --apiKey <key>", "Chave API")
  .option("-s, --secret <secret>", "Segredo API")
  .action(async (options: AddExchangeOptions): Promise<void> => {
    try {
      await initializeDatabase();
      const exchange: Exchange = await addExchange(
        options.name,
        options.type as "spot" | "futures",
        options.apiKey,
        options.secret
      );
      logger.info(`Exchange ${exchange.name} (${exchange.type}) adicionada com ID ${exchange.id}`);
    } catch (error: unknown) {
      logger.error(`Erro ao adicionar exchange: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// Comando para remover uma exchange
program
  .command("remove-exchange")
  .description("Remover uma exchange cadastrada")
  .option("-n, --name <name>", "Nome da exchange a remover (ex.: bybit-spot)")
  .action(async (options: RemoveExchangeOptions): Promise<void> => {
    try {
      await initializeDatabase();
      const exchangeRepository = AppDataSource.getRepository("Exchange");
      const exchange: Exchange | any = await exchangeRepository.findOne({ where: { name: options.name } });

      if (!exchange) {
        logger.error(`Exchange ${options.name} não encontrada`);
        process.exit(1);
      }

      await exchangeRepository.remove(exchange);
      logger.info(`Exchange ${options.name} removida com sucesso`);
      await updateCompatibleSymbols();
    } catch (error: unknown) {
      logger.error(`Erro ao remover exchange: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// Comando para parear símbolos
program
  .command("pair-symbols")
  .description("Parear e salvar símbolos compatíveis entre as exchanges")
  .action(async (): Promise<void> => {
    try {
      await initializeDatabase();
      await updateCompatibleSymbols();
    } catch (error: unknown) {
      logger.error(`Erro ao parear símbolos: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// Comando para sincronizar dados com as exchanges
program
  .command("sync")
  .description("Sincronizar saldo, preços, ordens e posições com as exchanges")
  .option("-e, --exchanges <names>", "Exchanges a sincronizar (ex.: gate-spot,bybit-futures)", (val: string): string[] => val.split(","))
  .action(async (options: SyncOptions): Promise<void> => {
    try {
      await initializeDatabase();
      const allExchanges: Exchange[] = await getExchanges();
      const selectedExchanges: Exchange[] = options.exchanges
        ? allExchanges.filter((ex: Exchange) => options.exchanges?.includes(ex.name))
        : allExchanges;

      if (selectedExchanges.length === 0) {
        logger.error("Nenhuma exchange selecionada ou cadastrada");
        process.exit(1);
      }

      const priceRepository = AppDataSource.getRepository(Price);
      const positionRepository = AppDataSource.getRepository(Position);
      const tradeRepository = AppDataSource.getRepository(Trade);
      const balanceRepository = AppDataSource.getRepository(Balance);
      const symbolRepository = AppDataSource.getRepository(CompatibleSymbol);

      for (const ex of selectedExchanges) {
        const instance: any = ex.getInstance();
        logger.info(`Sincronizando ${ex.name}...`);

        // Sincronizar saldo
        try {
          const balanceData: { total: { [key: string]: number } } = await instance.fetchBalance();
          for (const [asset, amount] of Object.entries(balanceData.total)) {
            if (!asset) continue; // Ignora caso asset seja undefined ou vazio
            const balance: Balance = new Balance();
            balance.exchange = ex.name;
            balance.asset = asset; // Usando 'asset' em vez de 'currency'
            balance.amount = amount;
            balance.timestamp = new Date();
            await balanceRepository.save(balance);
          }
          logger.info(`Saldo sincronizado para ${ex.name}`);
        } catch (error: unknown) {
          logger.error(`Erro ao sincronizar saldo para ${ex.name}: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Sincronizar preços dos símbolos compatíveis
        const compatibleSymbols: CompatibleSymbol[] = await symbolRepository.find({ where: { exchanges: ex.name } });
        for (const cs of compatibleSymbols) {
          try {
            const ticker: { last: number; baseVolume: number } = await instance.fetchTicker(cs.symbol);
            const price: Price = new Price();
            price.symbol = cs.symbol;
            price.exchange = ex.name;
            price.price = ticker.last || 0;
            price.volume = ticker.baseVolume || 0;
            price.timestamp = new Date();
            await priceRepository.save(price);
          } catch (error: unknown) {
            logger.error(`Erro ao sincronizar preço para ${cs.symbol} em ${ex.name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        logger.info(`Preços sincronizados para ${ex.name}`);

        // Sincronizar ordens abertas
        try {
          const openOrders: Array<{ id: string; symbol: string; side: string; amount: number; price: number; timestamp: number }> = await instance.fetchOpenOrders();
          for (const order of openOrders) {
            const trade: Trade = new Trade();
            trade.symbol = order.symbol;
            trade.exchange = ex.name;
            trade.type = order.side as any;
            trade.amount = order.amount;
            trade.price = order.price || 0;
            trade.timestamp = new Date(order.timestamp);
            trade.success = false;
            trade.id = parseInt(order.id);
            await tradeRepository.save(trade);
          }
          logger.info(`Ordens sincronizadas para ${ex.name}: ${openOrders.length} ordens abertas`);
        } catch (error: unknown) {
          logger.error(`Erro ao sincronizar ordens para ${ex.name}: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Sincronizar posições abertas apenas para exchanges futures
        if (ex.type === "futures") {
          try {
            if (instance.has['fetchPositions']) {
              const positions: Array<{ symbol: string; contracts: number; entryPrice: number; timestamp?: number }> = await instance.fetchPositions(symbols);
              for (const pos of positions) {
                const position: Position = new Position();
                position.symbol = pos.symbol;
                position.exchange = ex.name;
                position.amount = pos.contracts || 0;
                position.buyPrice = pos.entryPrice || 0;
                position.stopLossPrice = pos.entryPrice ? pos.entryPrice * (1 - 5 / 100) : 0;
                position.timestamp = new Date(pos.timestamp || Date.now());
                position.closed = false;
                await positionRepository.save(position);
              }
              logger.info(`Posições sincronizadas para ${ex.name}: ${positions.length} posições abertas`);
            }
          } catch (error: unknown) {
            logger.error(`Erro ao sincronizar posições para ${ex.name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else {
          logger.info(`Posições não sincronizadas para ${ex.name} (não é futures)`);
        }
      }
      logger.info("Sincronização concluída");
    } catch (error: unknown) {
      logger.error(`Erro durante sincronização: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// Comando para cancelar todas as ordens
program
  .command("cancel-all-orders")
  .description("Cancelar todas as ordens abertas")
  .option("-e, --exchange <name>", "Filtrar por exchange (ex.: gate-spot)")
  .action(async (options: CancelAllOrdersOptions): Promise<void> => {
    try {
      await initializeDatabase();
      const tradeRepository = AppDataSource.getRepository(Trade);
      const exchanges: Exchange[] = await getExchanges();
      const trades: Trade[] = options.exchange
        ? await tradeRepository.find({ where: { exchange: options.exchange, success: false } })
        : await tradeRepository.find({ where: { success: false } });

      if (trades.length === 0) {
        logger.info("Nenhuma ordem aberta encontrada para cancelar.");
        return;
      }

      for (const trade of trades) {
        const exchange = exchanges.find((ex: Exchange) => ex.name === trade.exchange);
        if (!exchange) continue;

        const instance: any = exchange.getInstance();
        try {
          await instance.cancelOrder(trade.id.toString(), trade.symbol);
          trade.success = false;
          trade.error = "Ordem cancelada manualmente";
          await tradeRepository.save(trade);
          logger.info(`Ordem ${trade.id} (${trade.type} ${trade.symbol}) cancelada em ${trade.exchange}`);
        } catch (error: unknown) {
          logger.error(`Erro ao cancelar ordem ${trade.id} em ${trade.exchange}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      logger.info(`Cancelamento concluído: ${trades.length} ordens processadas`);
    } catch (error: unknown) {
      logger.error(`Erro ao cancelar todas as ordens: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// Comando para monitorar oportunidades
program
  .command("monitor")
  .description("Monitorar exchanges para arbitragem e convergência")
  .option("-e, --exchanges <names>", "Exchanges a monitorar (ex.: bybit-spot,gate-spot)", (val: string): string[] => val.split(","))
  .option("-s, --symbols <symbols>", "Símbolos a monitorar (ex.: BTC/USDT,ETH/USDT)", (val: string): string[] => val.split(","))
  .option("-a, --auto", "Executar trades automaticamente")
  .option("-v, --min-volume <value>", "Volume mínimo nas 24h", parseFloat, 100)
  .option("-p, --min-profit <value>", "Lucro mínimo desejado", parseFloat, 1)
  .option("-m, --max-profit <value>", "Lucro máximo permitido", parseFloat, 5)
  .option("-l, --stop-loss <percent>", "Stop-loss em %", parseFloat, 5)
  .option("-t, --timeout <ms>", "Timeout para stop-loss em ms", parseFloat, 3600000)
  .option("-ta, --trade-amount <value>", "Montante para trades em USDT", parseFloat, 5)
  .option("-cr, --convergence-range <value>", "Range de convergência em USDT", parseFloat)
  .option("-sl, --symbol-limit <value>", "Limite máximo de símbolos a monitorar", parseInt, 1000)
  .option("--test", "Usar modo de teste (ex.: Binance Testnet)")
  .option("--all-symbols", "Monitorar todos os símbolos compatíveis das exchanges")
  .action(async (options: MonitorOptions): Promise<void> => {
    try {
      await initializeDatabase();
      let allExchanges: Exchange[] = await getExchanges();

      if (options.test) {
        allExchanges = allExchanges.map((ex: Exchange): Exchange => {
          const instance: any = ex.getInstance();
          instance.urls["api"] = instance.urls["test"];
          return ex;
        });
        logger.info("Executando em modo de teste (Testnet). Use chaves de API do Binance Testnet: https://testnet.binance.vision/");
      } else {
        logger.warn("Executando em modo real. Certifique-se de que as chaves de API estão configuradas corretamente.");
      }

      const selectedExchanges: Exchange[] = options.exchanges
        ? allExchanges.filter((ex: Exchange) => options.exchanges?.includes(ex.name))
        : allExchanges;

      if (selectedExchanges.length === 0) {
        logger.error("Nenhuma exchange selecionada ou cadastrada");
        process.exit(1);
      }

      let symbolsToMonitor: string[];
      if (options.allSymbols) {
        const symbolRepository = AppDataSource.getRepository(CompatibleSymbol);
        const compatibleSymbols: CompatibleSymbol[] = await symbolRepository.find();
        if (compatibleSymbols.length === 0) {
          logger.error("Nenhum símbolo compatível encontrado no banco. Execute 'pair-symbols' primeiro.");
          process.exit(1);
        }

        const symbolLimit: number = isNaN(options.symbolLimit) ? 1000 : options.symbolLimit;
        symbolsToMonitor = compatibleSymbols
          .filter((cs: CompatibleSymbol) => selectedExchanges.every((ex: Exchange) => cs.exchanges.includes(ex.name)))
          .map((cs: CompatibleSymbol) => cs.symbol)
          .slice(0, symbolLimit);
        logger.info(`Monitorando ${symbolsToMonitor.length} símbolos compatíveis (limite: ${symbolLimit}): ${symbolsToMonitor.join(", ")}`);
      } else {
        symbolsToMonitor = options.symbols || [];
        if (symbolsToMonitor.length === 0) {
          logger.error("Nenhum símbolo especificado. Use --symbols ou --all-symbols.");
          process.exit(1);
        }
        logger.info(`Monitorando símbolos especificados: ${symbolsToMonitor.join(", ")}`);
      }

      logger.info(`Monitorando ${selectedExchanges.length} exchanges com:`);
      logger.info(`  Volume mínimo: ${options.minVolume}`);
      logger.info(`  Lucro mínimo: ${options.minProfit}, máximo: ${options.maxProfit}`);
      logger.info(`  Stop-loss: ${options.stopLoss}%, Timeout: ${options.timeout}ms`);
      logger.info(`  Montante da ordem: ${options.tradeAmount} USDT`);
      logger.info(`  Range de convergência: ${options.convergenceRange} USDT`);

      while (true) {
        const opportunities: Opportunity[] = await monitorOpportunities(
          selectedExchanges,
          symbolsToMonitor,
          options.minVolume,
          options.minProfit,
          options.maxProfit,
          options.tradeAmount,
          options.stopLoss,
          options.timeout,
          options.convergenceRange
        );

        for (const op of opportunities) {
          logger.info(`Oportunidade: ${op.type} | ${op.buyExchange} -> ${op.sellExchange} | ${op.symbol} | Lucro: ${op.profit}`);
          if (options.auto) {
            await executeOpportunity(op, selectedExchanges);
          }
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      }
    } catch (error: unknown) {
      logger.error(`Erro ao monitorar oportunidades: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// Comando para ver o portfólio (moedas compradas e valor em USD)
program
  .command("portfolio")
  .description("Listar moedas compradas e valor total em dólares")
  .option("-e, --exchange <name>", "Filtrar por exchange (ex.: gate-spot)")
  .action(async (options: PortfolioOptions): Promise<void> => {
    try {
      await initializeDatabase();
      const positionRepository = AppDataSource.getRepository(Position);
      const exchanges: Exchange[] = await getExchanges();
      const positions: Position[] = options.exchange
        ? await positionRepository.find({ where: { exchange: options.exchange, closed: false } })
        : await positionRepository.find({ where: { closed: false } });

      if (positions.length === 0) {
        logger.info("Nenhuma moeda comprada encontrada.");
        return;
      }

      let totalValueUSD: number = 0;
      for (const pos of positions) {
        const exchange = exchanges.find((ex: Exchange) => ex.name === pos.exchange);
        if (!exchange) continue;

        const instance: any = exchange.getInstance();
        const ticker: { last: number } = await instance.fetchTicker(pos.symbol);
        const currentPrice: number = ticker.last || 0;
        const valueUSD: number = pos.amount * currentPrice;
        totalValueUSD += valueUSD;

        logger.info(`${pos.symbol} (${pos.exchange}): ${pos.amount.toFixed(4)} unidades, Valor: $${valueUSD.toFixed(2)}`);
      }
      logger.info(`Valor total do portfólio: $${totalValueUSD.toFixed(2)}`);
    } catch (error: unknown) {
      logger.error(`Erro ao listar portfólio: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// Comando para ver o livro de ordens (ordens abertas)
program
  .command("orderbook")
  .description("Listar ordens abertas no livro de ordens")
  .option("-e, --exchange <name>", "Filtrar por exchange (ex.: gate-spot)")
  .action(async (options: OrderbookOptions): Promise<void> => {
    try {
      await initializeDatabase();
      const tradeRepository = AppDataSource.getRepository(Trade);
      const trades: Trade[] = options.exchange
        ? await tradeRepository.find({ where: { exchange: options.exchange, success: false } })
        : await tradeRepository.find({ where: { success: false } });

      if (trades.length === 0) {
        logger.info("Nenhuma ordem aberta encontrada.");
        return;
      }

      logger.info("Ordens abertas:");
      for (const trade of trades) {
        logger.info(`ID: ${trade.id} | ${trade.type.toUpperCase()} ${trade.symbol} em ${trade.exchange} | Quantidade: ${trade.amount} | Preço: ${trade.price} | Status: ${trade.error || "Pendente"}`);
      }
    } catch (error: unknown) {
      logger.error(`Erro ao listar livro de ordens: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// Comando para cancelar uma ordem
program
  .command("cancel-order")
  .description("Cancelar uma ordem de compra ou venda")
  .option("-i, --id <id>", "ID da ordem a cancelar", parseInt)
  .action(async (options: CancelOrderOptions): Promise<void> => {
    try {
      await initializeDatabase();
      const tradeRepository = AppDataSource.getRepository(Trade);
      const exchanges: Exchange[] = await getExchanges();

      let trade: Trade | null = null;
      for (const ex of exchanges) {
        const instance: any = ex.getInstance();
        const openOrders: Array<{ id: string; symbol: string; side: string; amount: number; price: number; timestamp: number }> = await instance.fetchOpenOrders();
        const order = openOrders.find((o) => parseInt(o.id) === options.id);
        if (order) {
          trade = await tradeRepository.findOne({ where: { id: options.id, success: false } });
          if (!trade) {
            trade = new Trade();
            trade.id = parseInt(order.id);
            trade.symbol = order.symbol;
            trade.exchange = ex.name;
            trade.type = order.side as any;
            trade.amount = order.amount;
            trade.price = order.price || 0;
            trade.timestamp = new Date(order.timestamp);
            trade.success = false;
          }
          break;
        }
      }

      if (!trade) {
        logger.error(`Ordem com ID ${options.id} não encontrada ou já concluída`);
        process.exit(1);
      }

      const exchange = exchanges.find((ex: Exchange) => ex.name === trade.exchange);
      if (!exchange) {
        logger.error(`Exchange ${trade.exchange} não encontrada`);
        process.exit(1);
      }

      const instance: any = exchange.getInstance();
      await instance.cancelOrder(trade.id.toString(), trade.symbol);
      trade.success = false;
      trade.error = "Ordem cancelada manualmente";
      await tradeRepository.save(trade);
      logger.info(`Ordem ${trade.id} (${trade.type} ${trade.symbol}) cancelada com sucesso`);
    } catch (error: unknown) {
      logger.error(`Erro ao cancelar ordem ${options.id}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// Comando para listar estatísticas de volume
program
  .command("volume-stats")
  .description("Exibir estatísticas de volume das exchanges")
  .option("-s, --symbol <symbol>", "Filtrar por símbolo (ex.: BTC/USDT)")
  .action(async (options: VolumeStatsOptions): Promise<void> => {
    try {
      await initializeDatabase();
      const priceRepository = AppDataSource.getRepository(Price);
      const query = priceRepository.createQueryBuilder("price")
        .select("price.exchange", "exchange")
        .addSelect("price.symbol", "symbol")
        .addSelect("AVG(price.volume)", "avgVolume")
        .addSelect("MIN(price.volume)", "minVolume")
        .addSelect("MAX(price.volume)", "maxVolume")
        .groupBy("price.exchange")
        .addGroupBy("price.symbol");

      if (options.symbol) {
        query.where("price.symbol = :symbol", { symbol: options.symbol });
      }

      const stats: Array<{ exchange: string; symbol: string; avgVolume: number; minVolume: number; maxVolume: number }> = await query.getRawMany();
      logger.info("Estatísticas de Volume:");
      stats.forEach((stat) => {
        logger.info(`${stat.exchange} (${stat.symbol}):`);
        logger.info(`  Média: ${stat.avgVolume.toFixed(2)}`);
        logger.info(`  Mínimo: ${stat.minVolume}`);
        logger.info(`  Máximo: ${stat.maxVolume}`);
      });
    } catch (error: unknown) {
      logger.error(`Erro ao listar estatísticas de volume: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// Variável global para símbolos (usada no sync)
let symbols: string[] = [];

// Executa o parsing dos comandos
program.parse(process.argv);