import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";

@Entity()
export class Balance {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ nullable: false })
  exchange!: string;

  @Column({ nullable: false }) // Ajustado de 'currency' para 'asset'
  asset!: string;

  @Column({ type: "float" })
  amount!: number;

  @Column()
  timestamp!: Date;
}