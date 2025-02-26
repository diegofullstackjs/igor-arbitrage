import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";
import * as ccxt from "ccxt";
import {pro as ccxtPro} from "ccxt";

@Entity()
export class Exchange {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  type!: "spot" | "futures";

  @Column()
  apiKey!: string;

  @Column()
  secret!: string;

  getInstance() {
    const config = { apiKey: this.apiKey, secret: this.secret,
      ...(this.name === "bybit" ? { options: { adjustForTimeDifference: true } } : {})

     };

    if (this.type === "spot") {
      const exchangeClass = (ccxt as any)[this.name];
      if (!exchangeClass) {
        throw new Error(`Exchange ${this.name} não suportada pela CCXT para spot`);
      }
      return new exchangeClass(config);
    } else if (this.type === "futures") {
      const exchangeClass = (ccxtPro as any)[this.name];
      if (!exchangeClass) {
        throw new Error(`Exchange ${this.name} não suportada pela CCXT Pro para futures`);
      }
      return new exchangeClass(config);
    } else {
      throw new Error(`Tipo ${this.type} não suportado. Use 'spot' ou 'futures'`);
    }
  }
}