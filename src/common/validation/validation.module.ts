import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { createValidationPipe } from './validation.pipe';

@Module({
  providers: [{ provide: APP_PIPE, useFactory: createValidationPipe }],
})
export class ValidationModule {}
