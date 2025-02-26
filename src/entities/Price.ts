import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";
@Entity()
export class Price {
  @PrimaryGeneratedColumn() id!: number;
  @Column() symbol!: string;
  @Column() exchange!: string;
  @Column("float") price!: number;
  @Column("float", { nullable: true }) volume?: number;
  @Column() timestamp!: Date;
  @Column({ nullable: true }) opportunityType?: "arbitrage" | "convergence";
  @Column({ nullable: true }) profit?: number;
}
