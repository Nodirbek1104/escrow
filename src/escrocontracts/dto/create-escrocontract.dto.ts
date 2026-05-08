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
import { CreatorRole } from '../entities/escrocontract.entity';

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

  /** Who is creating: buyer (default — invites executor) or executor
   *  (publishes an Offer — invites buyer). */
  @IsOptional()
  @IsEnum(CreatorRole)
  creatorRole?: CreatorRole;

  /** Required when creatorRole='executor': the executor's payout card,
   *  pre-selected at creation time so the buyer just pays. */
  @IsOptional()
  @IsString()
  receiverCardId?: string;
}