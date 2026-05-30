import { Test, TestingModule } from '@nestjs/testing';
import { EscrocontractsController } from './escrocontracts.controller';
import { EscrocontractsService } from './escrocontracts.service';

describe('EscrocontractsController', () => {
  let controller: EscrocontractsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EscrocontractsController],
      providers: [
        {
          provide: EscrocontractsService,
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<EscrocontractsController>(EscrocontractsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
