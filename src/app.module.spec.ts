import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

it('AppModule compiles', async () => {
  const ref = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  expect(ref).toBeDefined();
});
