import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports liveness', () => {
    expect(new HealthController().live()).toEqual({ status: 'ok' });
  });
});
