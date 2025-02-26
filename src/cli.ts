import { program } from "commander";
import { initializeDatabase, AppDataSource } from "./db";
import { addExchange, getExchanges } from "./exchanges";
import { monitorOpportunities, executeOpportunity } from "./arbitrage";
import { Price } from "./entities/Price";
import logger from "./logger";

program
    .command("add-exchange")
    .description("Adicionar uma nova exchange")
    .option("-n, --name <name>", "Nome da exchange (ex.: binance)")
    .option("-t, --type <type>", "Tipo: spot ou futures")
    .option("-k, --apiKey <key>", "Chave API")
    .option("-s, --secret <secret>", "Segredo API")
    .action(async (options) => {
        await initializeDatabase();
        const exchange = await addExchange(options.name, options.type as "spot" | "futures", options.apiKey, options.secret);
        logger.info(`Exchange ${exchange.name} (${exchange.type}) adicionada com ID ${exchange.id}`);
    });

program
    .command("remove-exchange")
    .description("Remover uma exchange cadastrada")
    .option("-n, --name <name>", "Nome da exchange a remover (ex.: binance-spot)")
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
    });

program
    .command("monitor")
    .description("Monitorar exchanges para arbitragem e convergência")
    .option("-e, --exchanges <names>", "Exchanges a monitorar (ex.: binance-spot,kraken-spot)", (val) => val.split(","))
    .option("-s, --symbols <symbols>", "Pares a monitorar (ex.: BTC/USDT,ETH/USDT)", (val) => val.split(","), ["BTC/USDT", "ETH/USDT"])
    .option("-a, --auto", "Executar trades automaticamente")
    .option("-v, --min-volume <value>", "Volume mínimo nas 24h", parseFloat, 100)
    .option("-p, --min-profit <value>", "Lucro mínimo desejado", parseFloat, 5)
    .option("-m, --max-profit <value>", "Lucro máximo permitido", parseFloat, 1000)
    .option("-l, --stop-loss <percent>", "Stop-loss em %", parseFloat, 5)
    .option("-t, --timeout <ms>", "Timeout para stop-loss em ms", parseFloat, 3600000)
    .option("-ta, --trade-amount <value>", "Montante para trades em USDT", parseFloat, 5) // Nova opção
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

        let symbolsToMonitor: string[] = options.symbols;
        if (options.allSymbols) {
            const symbolSet = new Set<string>();
            await Promise.all(selectedExchanges.map(async (ex) => {
                const instance = ex.getInstance();
                const markets = await instance.loadMarkets();
                Object.keys(markets).forEach(symbol => symbolSet.add(symbol));
            }));
            symbolsToMonitor = Array.from(symbolSet);
            logger.info(`Monitorando todos os ${symbolsToMonitor.length} símbolos compatíveis: ${symbolsToMonitor.join(", ")}`);
        } else {
            logger.info(`Monitorando símbolos especificados: ${symbolsToMonitor.join(", ")}`);
        }

        logger.info(`Monitorando ${selectedExchanges.length} exchanges com:`);
        logger.info(`  Volume mínimo: ${options.minVolume}`);
        logger.info(`  Lucro mínimo: ${options.minProfit}, máximo: ${options.maxProfit}`);
        logger.info(`  Stop-loss: ${options.stopLoss}%, Timeout: ${options.timeout}ms`);
        logger.info(`  Montante da ordem: ${options.tradeAmount} USDT`);

        while (true) {
            const opportunities = await monitorOpportunities(
                selectedExchanges,
                symbolsToMonitor,
                options.minVolume,
                options.minProfit,
                options.maxProfit,
                options.tradeAmount, // Passa o tradeAmount configurado
                options.stopLoss,
                options.timeout
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