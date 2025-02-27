import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity()
export class CompatibleSymbol {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  symbol!: string;

  @Column("simple-array")
  exchanges!: string[]; // Lista de nomes das exchanges que suportam este símbolo
}
