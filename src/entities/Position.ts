import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";
@Entity()
export class Position {
  @PrimaryGeneratedColumn() id!: number;
  @Column() symbol!: string;
  @Column() exchange!: string;
  @Column("float") amount!: number;
  @Column("float") buyPrice!: number;
  @Column() timestamp!: Date;
  @Column({ default: false }) closed!: boolean;
  @Column("float", { nullable: true }) stopLossPrice?: number;
  @Column("float", { nullable: true }) sellPrice?: number;
  @Column("float", { nullable: true }) profit?: number;
}
