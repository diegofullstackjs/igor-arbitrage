import { program } from "commander";
import { initializeDatabase, AppDataSource } from "./db";
import { addExchange, getExchanges, updateCompatibleSymbols } from "./exchanges";
import { monitorOpportunities, executeOpportunity } from "./arbitrage";
import { Price } from "./entities/Price";
import { CompatibleSymbol } from "./entities/CompatibleSymbol";
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
        await updateCompatibleSymbols(); // Atualiza símbolos após remoção
    });

// Comando para parear símbolos manualmente
program
    .command("pair-symbols")
    .description("Parear e salvar símbolos compatíveis entre as exchanges")
    .action(async () => {
        await initializeDatabase();
        await updateCompatibleSymbols();
    });

// Comando para monitorar oportunidades de arbitragem
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
    .option("-ta, --trade-amount <value>", "Montante para trades em USDT", parseFloat, 1)
    .option("-cr, --convergence-range <value>", "Range de convergência em USDT", parseFloat, 5)
    .option("-sl, --symbol-limit <value>", "Limite máximo de símbolos a monitorar", parseInt, 1000)
    .option("--test", "Usar modo de teste (ex.: Binance Testnet)")
    .option("--all-symbols", "Monitorar todos os símbolos compatíveis das exchanges")
    .action(async (options) => {
        await initializeDatabase();
        let allExchanges = await getExchanges();

        // Configuração para modo de teste (Testnet)
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

        // Filtra as exchanges selecionadas ou usa todas se nenhuma for especificada
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
                .filter(cs => selectedExchanges.every(ex => cs.exchanges.includes(ex.name))) // Filtra por exchanges selecionadas
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

        // Exibe informações de configuração
        logger.info(`Monitorando ${selectedExchanges.length} exchanges com:`);
        logger.info(`  Volume mínimo: ${options.minVolume}`);
        logger.info(`  Lucro mínimo: ${options.minProfit}, máximo: ${options.maxProfit}`);
        logger.info(`  Stop-loss: ${options.stopLoss}%, Timeout: ${options.timeout}ms`);
        logger.info(`  Montante da ordem: ${options.tradeAmount} USDT`);
        logger.info(`  Range de convergência: ${options.convergenceRange} USDT`);

        // Loop infinito para monitoramento contínuo
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

            // Aguarda 5 segundos antes da próxima iteração
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    });

// Comando para exibir estatísticas de volume
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

// Executa o parsing dos comandos
program.parse();
