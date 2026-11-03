import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { TEST_ENV } from './config/testing';

beforeAll(() => Object.assign(process.env, TEST_ENV));

it('AppModule compiles', async () => {
  const ref = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  expect(ref).toBeDefined();
});
