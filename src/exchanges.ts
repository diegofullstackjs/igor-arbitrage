import { Exchange } from "./entities/Exchange";
import { CompatibleSymbol } from "./entities/CompatibleSymbol";
import { AppDataSource } from "./db";
import logger from "./logger";

export async function getExchanges(): Promise<Exchange[]> {
  const repository = AppDataSource.getRepository(Exchange);
  const rawExchanges = await repository.find();
  return rawExchanges.map(raw => {
    const exchange = new Exchange();
    exchange.id = raw.id;
    exchange.name = raw.name;
    exchange.type = raw.type;
    exchange.apiKey = raw.apiKey;
    exchange.secret = raw.secret;
    return exchange;
  });
}

export async function addExchange(name: string, type: "spot" | "futures", apiKey: string, secret: string): Promise<Exchange> {
  const repository = AppDataSource.getRepository(Exchange);
  const exchange = new Exchange();
  exchange.name = name;
  exchange.type = type;
  exchange.apiKey = apiKey;
  exchange.secret = secret;
  const savedExchange = await repository.save(exchange);

  // Atualiza símbolos compatíveis após adicionar a exchange
  await updateCompatibleSymbols();
  return savedExchange;
}

export async function updateCompatibleSymbols(): Promise<void> {
  const exchangeRepository = AppDataSource.getRepository(Exchange);
  const symbolRepository = AppDataSource.getRepository(CompatibleSymbol);
  const exchanges = await exchangeRepository.find();

  // Passo 1: Carrega todos os mercados de todas as exchanges
  const marketMap: { [key: string]: Set<string> } = {};
  const wsSupport: { [key: string]: boolean } = {};
  await Promise.all(exchanges.map(async (ex) => {
    const instance = ex.getInstance();
    try {
      const markets = await instance.loadMarkets();
      marketMap[ex.name] = new Set(Object.keys(markets));
      wsSupport[ex.name] = instance.has['watchTicker'] || false;
      logger.info(`Mercados iniciais carregados para ${ex.name} (WebSocket: ${wsSupport[ex.name]}): ${Object.keys(markets).join(", ")}`);
    } catch (error) {
      logger.error(`Erro ao carregar mercados para ${ex.name}: ${error instanceof Error ? error.message : String(error)}`);
      marketMap[ex.name] = new Set();
      wsSupport[ex.name] = false;
    }
  }));

  // Passo 2: Lista todos os símbolos únicos
  const allSymbols = new Set(Object.values(marketMap).flatMap(set => Array.from(set)));
  logger.info(`Total de ${allSymbols.size} símbolos únicos encontrados: ${Array.from(allSymbols).join(", ")}`);

  // Passo 3: Valida cada símbolo com WebSocket (se suportado) ou fetchTicker
  const symbolCompatibility: { [symbol: string]: string[] } = {};
  for (const symbol of allSymbols) {
    logger.info(`Validando símbolo ${symbol}...`);
    const compatibleExchanges: string[] = [];
    
    for (const ex of exchanges) {
      if (marketMap[ex.name].has(symbol)) {
        const instance = ex.getInstance();
        try {
          if (wsSupport[ex.name]) {
            // Usa WebSocket se suportado
            const ticker = await instance.watchTicker(symbol);
            if (ticker && ticker.last !== undefined) {
              compatibleExchanges.push(ex.name);
              logger.info(`Símbolo ${symbol} compatível em ${ex.name} via WebSocket`);
            } else {
              logger.warn(`Símbolo ${symbol} retornou dados inválidos em ${ex.name} via WebSocket`);
            }
          } else {
            // Fallback para fetchTicker
            const ticker = await instance.fetchTicker(symbol);
            if (ticker && ticker.last !== undefined) {
              compatibleExchanges.push(ex.name);
              logger.info(`Símbolo ${symbol} compatível em ${ex.name} via REST`);
            } else {
              logger.warn(`Símbolo ${symbol} retornou dados inválidos em ${ex.name} via REST`);
            }
          }
        } catch (error) {
          logger.warn(`Símbolo ${symbol} não é acessível em ${ex.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (compatibleExchanges.length >= 2) { // Exige compatibilidade em pelo menos um par spot-futures
      symbolCompatibility[symbol] = compatibleExchanges;
      logger.info(`Símbolo ${symbol} adicionado como compatível entre: ${compatibleExchanges.join(", ")}`);
    } else {
      logger.info(`Símbolo ${symbol} não é compatível entre pelo menos 2 exchanges`);
    }
  }

  // Passo 4: Limpa símbolos existentes e salva os novos
  await symbolRepository.clear();
  const compatibleSymbols = Object.entries(symbolCompatibility).map(([symbol, exchanges]) => {
    const cs = new CompatibleSymbol();
    cs.symbol = symbol;
    cs.exchanges = exchanges;
    return cs;
  });
  await symbolRepository.save(compatibleSymbols);
  logger.info(`Salvou ${compatibleSymbols.length} símbolos compatíveis no banco: ${compatibleSymbols.map(cs => cs.symbol).join(", ")}`);
}