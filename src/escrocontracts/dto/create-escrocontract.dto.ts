// src/escrocontracts/dto/create-escrocontract.dto.ts
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
} from 'class-validator';
import { ContractType } from '../entities/escrocontract.entity';

export class CreateEscrowContractDto {
  @IsString()
  @IsNotEmpty()
  title!: string;

  @Type(() => Number)
  @IsNumber()
  @IsNotEmpty()
  amount!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(3650)
  deadline!: number;

  @IsString()
  @IsNotEmpty()
  executorPhoneNumber!: string;

  /** Shartnoma turi: `buyer_initiated` (xaridor taklif qiladi, ijrochini
   *  chaqiradi) yoki `executor_initiated` (ijrochi "Offer" e'lon qiladi,
   *  xaridor kelib to'laydi). Default — buyer_initiated. */
  @IsOptional()
  @IsEnum(ContractType)
  contractType?: ContractType;

  /** Required when creatorRole='executor': the executor's payout card,
   *  pre-selected at creation time so the buyer just pays. */
  @IsOptional()
  @IsString()
  receiverCardId?: string;
}