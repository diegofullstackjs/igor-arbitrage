import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";
@Entity()
export class Trade {
  @PrimaryGeneratedColumn() id!: number;
  @Column() symbol!: string;
  @Column() exchange!: string;
  @Column() type!: "buy" | "sell";
  @Column("float") amount!: number;
  @Column("float") price!: number;
  @Column() timestamp!: Date;
  @Column({ default: true }) success!: boolean;
  @Column({ nullable: true }) error?: string;
}
