import { Test, TestingModule } from '@nestjs/testing';
import { EscrocontractsController } from './escrocontracts.controller';
import { EscrocontractsService } from './escrocontracts.service';
import { beforeEach, describe, it } from 'node:test';

describe('EscrocontractsController', () => {
  let controller: EscrocontractsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EscrocontractsController],
      providers: [EscrocontractsService],
    }).compile();

    controller = module.get<EscrocontractsController>(EscrocontractsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
