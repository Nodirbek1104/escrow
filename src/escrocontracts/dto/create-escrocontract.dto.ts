// src/escrocontracts/dto/create-escrocontract.dto.ts
import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsString, Min, Max } from 'class-validator';

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

}