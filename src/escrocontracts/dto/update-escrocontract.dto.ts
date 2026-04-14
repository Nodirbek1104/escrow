import { PartialType } from '@nestjs/mapped-types';
import { CreateEscrowContractDto } from './create-escrocontract.dto';

export class UpdateEscrocontractDto extends PartialType(CreateEscrowContractDto) {}


