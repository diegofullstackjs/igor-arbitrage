import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";
@Entity()
export class Balance {
  @PrimaryGeneratedColumn() id!: number;
  @Column() exchange!: string;
  @Column() asset!: string;
  @Column("float") free!: number;
  @Column("float") total!: number;
  @Column() timestamp!: Date;
}
