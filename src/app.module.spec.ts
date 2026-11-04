import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule, AppRole } from './app.module';
import { ValidationModule } from './common/validation';
import { TEST_ENV } from './config/testing';
import { fakeDataSource } from './database/testing';
import { HealthController } from './health/health.controller';
import { InvariantsController } from './modules/operations/invariants/invariants.controller';

beforeAll(() => Object.assign(process.env, TEST_ENV));

async function bootRole(role: AppRole) {
  const ref = await Test.createTestingModule({
    imports: [AppModule.forRole(role)],
  })
    .overrideProvider(DataSource)
    .useValue(fakeDataSource())
    .compile();
  const modules = [...ref.get(ModulesContainer, { strict: false }).values()];
  return {
    moduleTypes: modules.map((m) => m.metatype),
    controllers: modules.flatMap((m) =>
      [...m.controllers.values()].map((c) => c.metatype),
    ),
  };
}

describe('AppModule.forRole', () => {
  it('api loads the HTTP edge and the probes', async () => {
    const { moduleTypes, controllers } = await bootRole('api');
    expect(moduleTypes).toContain(ValidationModule);
    expect(controllers).toEqual(
      expect.arrayContaining([HealthController, InvariantsController]),
    );
    expect(controllers).toHaveLength(2);
  });

  it('worker loads no HTTP edge and only the probe controller', async () => {
    const { moduleTypes, controllers } = await bootRole('worker');
    expect(moduleTypes).not.toContain(ValidationModule);
    expect(controllers).toEqual([HealthController]);
  });

  it('all loads the HTTP edge as well', async () => {
    const { moduleTypes, controllers } = await bootRole('all');
    expect(moduleTypes).toContain(ValidationModule);
    expect(controllers).toEqual(
      expect.arrayContaining([HealthController, InvariantsController]),
    );
    expect(controllers).toHaveLength(2);
  });
});
