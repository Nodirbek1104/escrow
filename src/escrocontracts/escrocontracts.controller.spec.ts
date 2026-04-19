import { Test, TestingModule } from '@nestjs/testing';
import { EscrowContractController } from './escrocontracts.controller';
import { EscrocontractsService } from './escrocontracts.service';
import { beforeEach, describe, it } from 'node:test';

describe('EscrocontractsController', () => {
  let controller: EscrowContractController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EscrowContractController],
      providers: [EscrocontractsService],
    }).compile();

    controller = module.get<EscrowContractController>(EscrowContractController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
