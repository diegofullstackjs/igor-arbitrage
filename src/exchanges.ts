import { Exchange } from "./entities/Exchange";
import { AppDataSource } from "./db";

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
    return repository.save(exchange);
}