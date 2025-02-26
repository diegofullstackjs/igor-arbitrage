import { DataSource } from "typeorm";
import { Exchange } from "./entities/Exchange";
import { Price } from "./entities/Price";
import { Position } from "./entities/Position";
import { Trade } from "./entities/Trade";
import { Balance } from "./entities/Balance";
export const AppDataSource = new DataSource({
  type: "sqlite",
  database: "database.sqlite",
  synchronize: true,
  logging: false,
  entities: [Exchange, Price, Position, Trade, Balance],
});
export async function initializeDatabase() {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }
}
