import { program } from "commander";
import { initializeDatabase, AppDataSource } from "./db";
import { addExchange, getExchanges, updateCompatibleSymbols } from "./exchanges";
import { monitorOpportunities, executeOpportunity } from "./arbitrage";
import { Price } from "./entities/Price";
import { CompatibleSymbol } from "./entities/CompatibleSymbol";
import { Position } from "./entities/Position";
import { Trade } from "./entities/Trade";
import logger from "./logger";

// Comando para adicionar uma nova exchange
program
    .command("add-exchange")
    .description("Adicionar uma nova exchange")
    .option("-n, --name <name>", "Nome da exchange (ex.: gate, bybit)")
    .option("-t, --type <type>", "Tipo: spot ou futures")
    .option("-k, --apiKey <key>", "Chave API")
    .option("-s, --secret <secret>", "Segredo API")
    .action(async (options) => {
        await initializeDatabase();
        const exchange = await addExchange(options.name, options.type as "spot" | "futures", options.apiKey, options.secret);
        logger.info(`Exchange ${exchange.name} (${exchange.type}) adicionada com ID ${exchange.id}`);
    });

// Comando para remover uma exchange
program
    .command("remove-exchange")
    .description("Remover uma exchange cadastrada")
    .option("-n, --name <name>", "Nome da exchange a remover (ex.: bybit-spot)")
    .action(async (options) => {
        await initializeDatabase();
        const exchangeRepository = AppDataSource.getRepository("Exchange");
        const exchange = await exchangeRepository.findOne({ where: { name: options.name } });

        if (!exchange) {
            logger.error(`Exchange ${options.name} não encontrada`);
            process.exit(1);
        }

        await exchangeRepository.remove(exchange);
        logger.info(`Exchange ${options.name} removida com sucesso`);
        await updateCompatibleSymbols();
    });

// Comando para parear símbolos
program
    .command("pair-symbols")
    .description("Parear e salvar símbolos compatíveis entre as exchanges")
    .action(async () => {
        await initializeDatabase();
        await updateCompatibleSymbols();
    });

// Comando para monitorar oportunidades
program
    .command("monitor")
    .description("Monitorar exchanges para arbitragem e convergência")
    .option("-e, --exchanges <names>", "Exchanges a monitorar (ex.: bybit-spot,gate-spot)", (val) => val.split(","))
    .option("-s, --symbols <symbols>", "Símbolos a monitorar (ex.: BTC/USDT,ETH/USDT)", (val) => val.split(","))
    .option("-a, --auto", "Executar trades automaticamente")
    .option("-v, --min-volume <value>", "Volume mínimo nas 24h", parseFloat, 100)
    .option("-p, --min-profit <value>", "Lucro mínimo desejado", parseFloat, 1)
    .option("-m, --max-profit <value>", "Lucro máximo permitido", parseFloat, 5)
    .option("-l, --stop-loss <percent>", "Stop-loss em %", parseFloat, 5)
    .option("-t, --timeout <ms>", "Timeout para stop-loss em ms", parseFloat, 3600000)
    .option("-ta, --trade-amount <value>", "Montante para trades em USDT", parseFloat, 5)
    .option("-cr, --convergence-range <value>", "Range de convergência em USDT", parseFloat, 5)
    .option("-sl, --symbol-limit <value>", "Limite máximo de símbolos a monitorar", parseInt, 1000)
    .option("--test", "Usar modo de teste (ex.: Binance Testnet)")
    .option("--all-symbols", "Monitorar todos os símbolos compatíveis das exchanges")
    .action(async (options) => {
        await initializeDatabase();
        let allExchanges = await getExchanges();

        if (options.test) {
            allExchanges = allExchanges.map(ex => {
                const instance = ex.getInstance();
                instance.urls["api"] = instance.urls["test"];
                return ex;
            });
            logger.info("Executando em modo de teste (Testnet). Use chaves de API do Binance Testnet: https://testnet.binance.vision/");
        } else {
            logger.warn("Executando em modo real. Certifique-se de que as chaves de API estão configuradas corretamente.");
        }

        const selectedExchanges = options.exchanges
            ? allExchanges.filter(ex => options.exchanges.includes(ex.name))
            : allExchanges;

        if (selectedExchanges.length === 0) {
            logger.error("Nenhuma exchange selecionada ou cadastrada");
            process.exit(1);
        }

        let symbolsToMonitor: string[];
        if (options.allSymbols) {
            const symbolRepository = AppDataSource.getRepository(CompatibleSymbol);
            const compatibleSymbols = await symbolRepository.find();
            if (compatibleSymbols.length === 0) {
                logger.error("Nenhum símbolo compatível encontrado no banco. Execute 'pair-symbols' primeiro.");
                process.exit(1);
            }

            const symbolLimit = isNaN(options.symbolLimit) ? 1000 : options.symbolLimit;
            symbolsToMonitor = compatibleSymbols
                .filter(cs => selectedExchanges.every(ex => cs.exchanges.includes(ex.name)))
                .map(cs => cs.symbol)
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
            const opportunities = await monitorOpportunities(
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

            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    });

// Comando para ver o portfólio (moedas compradas e valor em USD)
program
    .command("portfolio")
    .description("Listar moedas compradas e valor total em dólares")
    .option("-e, --exchange <name>", "Filtrar por exchange (ex.: gate-spot)")
    .action(async (options) => {
        await initializeDatabase();
        const positionRepository = AppDataSource.getRepository(Position);
        const exchanges = await getExchanges();
        const positions = options.exchange
            ? await positionRepository.find({ where: { exchange: options.exchange, closed: false } })
            : await positionRepository.find({ where: { closed: false } });

        if (positions.length === 0) {
            logger.info("Nenhuma moeda comprada encontrada.");
            return;
        }

        let totalValueUSD = 0;
        for (const pos of positions) {
            const exchange = exchanges.find(ex => ex.name === pos.exchange);
            if (!exchange) continue;

            const instance = exchange.getInstance();
            const ticker = await instance.fetchTicker(pos.symbol);
            const currentPrice = ticker.last || 0;
            const valueUSD = pos.amount * currentPrice;
            totalValueUSD += valueUSD;

            logger.info(`${pos.symbol} (${pos.exchange}): ${pos.amount.toFixed(4)} unidades, Valor: $${valueUSD.toFixed(2)}`);
        }
        logger.info(`Valor total do portfólio: $${totalValueUSD.toFixed(2)}`);
    });

// Comando para ver o livro de ordens (ordens abertas)
program
    .command("orderbook")
    .description("Listar ordens abertas no livro de ordens")
    .option("-e, --exchange <name>", "Filtrar por exchange (ex.: gate-spot)")
    .action(async (options) => {
        await initializeDatabase();
        const tradeRepository = AppDataSource.getRepository(Trade);
        const trades = options.exchange
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
    });

// Comando para cancelar uma ordem
program
    .command("cancel-order")
    .description("Cancelar uma ordem de compra ou venda")
    .option("-i, --id <id>", "ID da ordem a cancelar", parseInt)
    .action(async (options) => {
        await initializeDatabase();
        const tradeRepository = AppDataSource.getRepository(Trade);
        const trade = await tradeRepository.findOne({ where: { id: options.id, success: false } });

        if (!trade) {
            logger.error(`Ordem com ID ${options.id} não encontrada ou já concluída`);
            process.exit(1);
        }

        const exchanges = await getExchanges();
        const exchange = exchanges.find(ex => ex.name === trade.exchange);
        if (!exchange) {
            logger.error(`Exchange ${trade.exchange} não encontrada`);
            process.exit(1);
        }

        const instance = exchange.getInstance();
        try {
            await instance.cancelOrder(trade.id.toString(), trade.symbol); // Assume que o ID da ordem na API é o mesmo no banco
            trade.success = false;
            trade.error = "Ordem cancelada manualmente";
            await tradeRepository.save(trade);
            logger.info(`Ordem ${trade.id} (${trade.type} ${trade.symbol}) cancelada com sucesso`);
        } catch (error) {
            logger.error(`Erro ao cancelar ordem ${trade.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    });

// Comando para listar estatísticas de volume
program
    .command("volume-stats")
    .description("Exibir estatísticas de volume das exchanges")
    .option("-s, --symbol <symbol>", "Filtrar por símbolo (ex.: BTC/USDT)")
    .action(async (options) => {
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

        const stats = await query.getRawMany();
        logger.info("Estatísticas de Volume:");
        stats.forEach((stat: { exchange: string; symbol: string; avgVolume: number; minVolume: number; maxVolume: number }) => {
            logger.info(`${stat.exchange} (${stat.symbol}):`);
            logger.info(`  Média: ${stat.avgVolume.toFixed(2)}`);
            logger.info(`  Mínimo: ${stat.minVolume}`);
            logger.info(`  Máximo: ${stat.maxVolume}`);
        });
    });

program.parse();